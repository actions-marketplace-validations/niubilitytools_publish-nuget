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
    this.noBuild = JSON.parse(core.getInput('NO_BUILD'))
    this.signingCert = core.getInput('SIGNING_CERT_FILE_NAME')
    this.githubUser = core.getInput('GITHUB_ACTOR') // process.env.INPUT_GITHUB_USER || process.env.GITHUB_ACTOR

    if (this.nugetSource.startsWith(`https://api.nuget.org`)) {
      this.sourceName = 'nuget.org'
    } else {
      this.sourceName = this.nugetSource
    }

    const existingSources = this._executeCommand('dotnet nuget list source', { encoding: 'utf8' }).stdout
    if (existingSources.includes(this.nugetSource) === false) {
      let addSourceCmd
      if (this.nugetSource.startsWith(`https://nuget.pkg.github.com`)) {
        this.sourceType = 'GPR'
        addSourceCmd = `dotnet nuget add source ${this.nugetSource}/index.json --name=${this.sourceName} -u=${this.githubUser} -p=${this.nugetKey} --store-password-in-clear-text`
      } else {
        this.sourceType = 'NuGet'
        addSourceCmd = `dotnet nuget add source ${this.nugetSource}/v3/index.json --name=${this.sourceName}`
      }

      core.info(this._executeCommand(addSourceCmd, { encoding: 'utf-8' }).stdout)
    } else {
      core.info(this.nugetSource + ' is already in sources.')
    }

    const list1 = this._executeCommand('dotnet nuget list source', { encoding: 'utf8' }).stdout
    const enable = this._executeCommand(`dotnet nuget enable source ${this.sourceName}`, { encoding: 'utf8' }).stdout
    core.info(list1)
    core.info(enable)
  }

  _validateInputs() {
    // make sure we don't have badly configured version flags
    if (this.version && this.versionFile) core.info("You provided 'version', extract-* keys are being ignored")
  }

  _printErrorAndExit(msg) {
    core.error(`😭 ${msg}`)
    throw new Error(msg)
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
    var args = `--no-build -c Release -p:PackageVersion=${this.version} ${this.includeSymbols ? '--include-symbols -p:SymbolPackageFormat=snupkg' : ''} --no-build -c Release`

    return args
  }
  _pushPackage(version, name) {
    core.info(`✨ found new version (${version}) of ${name}`)

    if (this.sourceType == 'NuGet' && !this.nugetKey) {
      core.warning('😢 NUGET_KEY not given')
      return
    }

    core.info(`NuGet Source: ${this.nugetSource}`)

    fs.readdirSync('.')
      .filter((fn) => /\.s?nupkg$/.test(fn))
      .forEach((fn) => fs.unlinkSync(fn))

    if (!this.noBuild) this._executeInProcess(`dotnet build -c Release ${this.projectFile} /p:Version=${this.version}`)

    this._executeInProcess(`dotnet pack ${this._generatePackArgs()} ${this.projectFile} -o .`)

    const packages = fs.readdirSync('.').filter((fn) => fn.endsWith('nupkg'))
    core.info(`Generated Package(s): ${packages.join(', ')}`)

    packages
      .filter((p) => p.endsWith('.nupkg'))
      .forEach((nupkg) => {
        if (this.signingCert) this._executeInProcess(`dotnet nuget sign ${nupkg} -CertificatePath ${this.signingCert} -Timestamper http://timestamp.digicert.com`)

        // const pushCmd = `dotnet nuget push ${nupkg} -s ${this.nugetSource}/v3/index.json -k ${this.nugetKey} --skip-duplicate${!this.includeSymbols ? ' -n' : ''}`,
        const pushCmd = `dotnet nuget push ${nupkg} -s ${this.sourceName} ${this.sourceType !== 'GPR' ? `-k ${this.nugetKey}` : ''}--skip-duplicate${
            !this.includeSymbols ? ' -n' : ''
          }`,
          pushOutput = this._executeCommand(pushCmd, { encoding: 'utf-8' }).stdout
        core.info(pushOutput)

        if (/error/.test(pushOutput)) this._printErrorAndExit(`${/error.*/.exec(pushOutput)[0]}`)

        const symbolsFilename = nupkg.replace('.nupkg', '.snupkg'),
          fullpathsymbolsFilename = path.resolve(symbolsFilename)

        process.stdout.write(`::set-output name=PACKAGE_NAME::${nupkg}` + os.EOL)
        process.stdout.write(`::set-output name=PACKAGE_PATH::${path.resolve(nupkg)}` + os.EOL)

        if (symbolsFilename) {
          if (fs.existsSync(fullpathsymbolsFilename)) {
            process.stdout.write(`::set-output name=SYMBOLS_PACKAGE_NAME::${symbolsFilename}` + os.EOL)
            process.stdout.write(`::set-output name=SYMBOLS_PACKAGE_PATH::${fullpathsymbolsFilename}` + os.EOL)
          } else {
            core.warning(`supkg [${symbolsFilename}] is not existed. path:[${fullpathsymbolsFilename}]`)
          }
        }
      })

    if (this.tagCommit) this._tagCommit(version)
  }

  _checkForUpdate() {
    if (!this.packageName) {
      this.packageName = path.basename(this.projectFile).split('.').slice(0, -1).join('.')
    }

    core.info(`Package Name: ${this.packageName}`)

    let versionCheckUrl

    let options = {}

    //small hack to get package versions from Github Package Registry
    if (this.sourceType === 'GPR') {
      versionCheckUrl = `${this.nugetSource}/download/${this.packageName}/index.json`.toLowerCase()
      options = {
        method: 'GET',
        auth: `${this.githubUser}:${this.nugetKey}`,
      }
      core.info(`This is GPR, changing url for versioning...`)
    } else {
      versionCheckUrl = `${this.nugetSource}/v3-flatcontainer/${this.packageName}/index.json`.toLowerCase()
      options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36 Edg/100.0.1185.44',
        },
      }
    }
    core.info(`Url of checking Version: ${versionCheckUrl}`)

    https
      .get(versionCheckUrl, options, (res) => {
        let body = ''
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
        } else if (res.statusCode == 404) {
          core.warning(`Url '${versionCheckUrl}' is not available now or '${this.packageName}' was never uploaded on NuGet`)
          this._pushPackage(this.version, this.packageName)
        } else {
          this._printErrorAndExit(`error: ${res.statusCode}: ${res.statusMessage}`)
        }
      })
      .on('error', (e) => {
        this._printErrorAndExit(`error: ${e.message}`)
      })
  }

  run() {
    this._validateInputs()

    if (!this.projectFile || !fs.existsSync(this.projectFile)) this._printErrorAndExit(`Project file '${this.projectFile}' not found`)

    core.info(`Project Filepath: ${this.projectFile}`)
    core.debug(`Version (pre): '${this.version}'`)

    if (!this.version) {
      if (this.versionFile !== this.projectFile && !fs.existsSync(this.versionFile)) this._printErrorAndExit('version file not found')

      core.info(`Version Filepath: ${this.versionFile}`)
      core.info(`Version Regex: ${this.versionRegex}`)

      const versionFileContent = fs.readFileSync(this.versionFile, { encoding: 'utf-8' }),
        parsedVersion = this.versionRegex.exec(versionFileContent)

      if (!parsedVersion) this._printErrorAndExit('unable to extract version info!')

      this.version = parsedVersion[1]
    }

    core.info(`Version: ${this.version}`)

    this._checkForUpdate()
  }
}

new Action().run()
