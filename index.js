const os = require('os'),
  fs = require('fs'),
  path = require('path'),
  https = require('https'),
  spawnSync = require('child_process').spawnSync,
  core = require('@actions/core')

class Action {
  constructor() {
    this.projectFile = core.getInput('PROJECT_FILE_PATH')
    this.packageName = core.getInput('PACKAGE_NAME')
    this.versionFile = core.getInput('VERSION_FILE_PATH') || this.projectFile
    this.versionRegex = new RegExp(core.getInput('VERSION_REGEX'), 'm')
    this.version = core.getInput('VERSION_STATIC')
    this.tagCommit = JSON.parse(core.getInput('TAG_COMMIT'))
    this.tagFormat = core.getInput('TAG_FORMAT')
    this.nugetKey = core.getInput('NUGET_KEY')
    this.nugetSource = core.getInput('NUGET_SOURCE')
    this.includeSymbols = JSON.parse(core.getInput('INCLUDE_SYMBOLS'))
    this.errorContinue = JSON.parse(core.getInput('ERROR_CONTINUE'))
  }

  _validateInputs() {
    // make sure we don't have badly configured version flags
    if (this.version && this.versionFile) core.info("You provided 'version', extract-* keys are being ignored")
  }

  _printError(msg) {
    if (this.errorContinue) {
      core.warning(`😢 ${msg}`)
    } else {
      core.error(`😭 ${msg}`)
      throw new Error(msg)
    }
  }

  _executeCommand(cmd, options) {
    core.info(`executing: [${cmd}]`)

    const INPUT = cmd.split(' '),
      TOOL = INPUT[0],
      ARGS = INPUT.slice(1)
    return spawnSync(TOOL, ARGS, options)
  }

  _executeInProcess(cmd) {
    this._executeCommand(cmd, { encoding: 'utf-8', stdio: [process.stdin, process.stdout, process.stderr] })
  }

  _tagCommit(version) {
    const TAG = this.tagFormat.replace('*', version)

    core.info(`✨ creating new tag ${TAG}`)

    this._executeInProcess(`git tag ${TAG}`)
    this._executeInProcess(`git push origin ${TAG}`)

    process.stdout.write(`::set-output name=VERSION::${TAG}` + os.EOL)
  }

  _generatePackArgs() {
    var args = `--no-build -c Release -p:PackageVersion=${this.version}`

    if (this.includeSymbols) args = args + ' --INCLUDE_SYMBOLS -p:SymbolPackageFormat=snupkg'

    return args
  }
  _pushPackage(version, name) {
    core.info(`✨ found new version (${version}) of ${name}`)

    if (!this.nugetKey) {
      core.warning('😢 NUGET_KEY not given')
      return
    }

    core.info(`NuGet Source: ${this.nugetSource}`)

    fs.readdirSync('.')
      .filter((fn) => /\.s?nupkg$/.test(fn))
      .forEach((fn) => fs.unlinkSync(fn))

    this._executeInProcess(`dotnet build -c Release ${this.projectFile} /p:Version=${this.version}`)

    this._executeInProcess(`dotnet pack ${this._generatePackArgs()} ${this.projectFile} -o .`)

    const packages = fs.readdirSync('.').filter((fn) => fn.endsWith('nupkg'))
    core.info(`Generated Package(s): ${packages.join(', ')}`)

    packages.forEach((nupkg) => {
      const pushCmd = `dotnet nuget push ${nupkg} -s ${this.nugetSource}/v3/index.json -k ${this.nugetKey} --skip-duplicate ${!this.includeSymbols ? '--no-symbols' : ''}`
      const pushOutput = this._executeCommand(pushCmd, { encoding: 'utf-8' }).stdout
      core.info(pushOutput)

      if (/error/.test(pushOutput)) this._printError(`${/error.*/.exec(pushOutput)[0]}`)
    })

    const packageFilename = packages.filter((p) => p.endsWith('.nupkg'))[0],
      symbolsFilename = packages.filter((p) => p.endsWith('.snupkg'))[0]

    process.stdout.write(`::set-output name=PACKAGE_NAME::${packageFilename}` + os.EOL)
    process.stdout.write(`::set-output name=package-path::${path.resolve(packageFilename)}` + os.EOL)

    if (symbolsFilename) {
      process.stdout.write(`::set-output name=symbols-PACKAGE_NAME::${symbolsFilename}` + os.EOL)
      process.stdout.write(`::set-output name=symbols-package-path::${path.resolve(symbolsFilename)}` + os.EOL)
    }

    if (this.tagCommit) this._tagCommit(version)
  }

  _checkForUpdate() {
    if (!this.packageName) {
      this.packageName = path.basename(this.projectFile).split('.').slice(0, -1).join('.')
    }

    core.info(`Package Name: ${this.packageName}`)

    let versionCheckUrl = `${this.nugetSource}/v3-flatcontainer/${this.packageName}/index.json`
    core.info(`Url of checking Version: ${versionCheckUrl}`)
    let options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36 Edg/100.0.1185.44',
      },
    }
    https
      .get(versionCheckUrl, options, (res) => {
        let body = ''

        if (res.statusCode == 404) {
          core.info(`##[warning]😢 Url '${versionCheckUrl}' is not available now or '${this.packageName}' was never uploaded on NuGet`)
          this._pushPackage(this.version, this.packageName)
        }

        if (res.statusCode == 200) {
          res.setEncoding('utf8')
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => {
            const existingVersions = JSON.parse(body)
            if (existingVersions.versions.indexOf(this.version) < 0) {
              core.info(`Current version ${this.version} is not found in NuGet. Versions:${existingVersions.versions}`)
              this._pushPackage(this.version, this.packageName)
            } else core.info(`Found the version: ${this.nugetSource.replace('api.', '')}/packages/${this.packageName}/${this.version}`)
          })
        }
      })
      .on('error', (e) => {
        this._printError(`error: ${e.message}`)
      })
  }

  run() {
    this._validateInputs()

    if (!this.projectFile || !fs.existsSync(this.projectFile)) this._printError(`Project file '${this.projectFile}' not found`)

    core.info(`Project Filepath: ${this.projectFile}`)
    core.debug(`Version (pre): '${this.version}'`)

    if (!this.version) {
      if (this.versionFile !== this.projectFile && !fs.existsSync(this.versionFile)) this._printError('version file not found')

      core.info(`Version Filepath: ${this.versionFile}`)
      core.info(`Version Regex: ${this.versionRegex}`)

      const versionFileContent = fs.readFileSync(this.versionFile, { encoding: 'utf-8' }),
        parsedVersion = this.versionRegex.exec(versionFileContent)

      if (!parsedVersion) this._printError('unable to extract version info!')

      this.version = parsedVersion[1]
    }

    core.info(`Version: ${this.version}`)

    this._checkForUpdate()
  }
}

new Action().run()
