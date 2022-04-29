const os = require('os'),
  fs = require('fs'),
  path = require('path'),
  https = require('https'),
  spawnSync = require('child_process').spawnSync,
  core = require('@actions/core')

class Action {
  constructor() {
    this.projectFile = process.env.INPUT_PROJECT_FILE_PATH
    this.packageName = process.env.INPUT_PACKAGE_NAME || process.env.PACKAGE_NAME
    this.versionFile = process.env.INPUT_VERSION_FILE_PATH || process.env.VERSION_FILE_PATH || this.projectFile
    this.versionRegex = new RegExp(process.env.INPUT_VERSION_REGEX || process.env.VERSION_REGEX, 'm')
    this.version = process.env.INPUT_VERSION_STATIC || process.env.VERSION_STATIC
    this.nugetSource = process.env.INPUT_NUGET_SOURCE || process.env.NUGET_SOURCE
  }

  _printError(msg) {
    console.log(`##[error]😭 ${msg}`)

    if (!this.errorContinue) throw new Error(msg)
  }

  _executeCommand(cmd, options) {
    console.log(`executing: [${cmd}]`)

    const INPUT = cmd.split(' '),
      TOOL = INPUT[0],
      ARGS = INPUT.slice(1)
    return spawnSync(TOOL, ARGS, options)
  }

  _executeInProcess(cmd) {
    this._executeCommand(cmd, { encoding: 'utf-8', stdio: [process.stdin, process.stdout, process.stderr] })
  }

  _checkForUpdate() {
    if (!this.packageName) {
      this.packageName = path.basename(this.projectFile).split('.').slice(0, -1).join('.')
    }

    console.log(`Package Name: ${this.packageName}`)

    let versionCheckUrl = `${this.nugetSource}/v3-flatcontainer/${this.packageName}/index.json`
    console.log(`Url of checking Version: ${versionCheckUrl}`)
    let options = {
      headers: {
        //  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36 Edg/100.0.1185.44',
      },
    }
    https
      .get(versionCheckUrl, options, (res) => {
        let body = ''

        if (res.statusCode == 404) {
          console.log(`##[warning]😢 ${this.packageName} was never uploaded on NuGet or version checking url is not available now`)
          this._pushPackage(this.version, this.packageName)
        }

        if (res.statusCode == 200) {
          res.setEncoding('utf8')
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => {
            const existingVersions = JSON.parse(body)
            if (existingVersions.versions.indexOf(this.version) < 0) {
              console.log(`Current version ${this.version} is not found in NuGet. Versions:${existingVersions.versions}`)
              //   this._pushPackage(this.version, this.packageName)
            } else console.log(`Found the version: ${this.nugetSource.replace('api.', '')}/packages/${this.packageName}/${this.version}`)
          })
        }
      })
      .on('error', (e) => {
        this._printError(`error: ${e.message}`)
      })
  }
}

let a = new Action()

a.packageName = 'Niubility.EmitMapper'
a.nugetSource = 'https://api.nuget.org'
a.version = '2.1.6'

a._checkForUpdate()
