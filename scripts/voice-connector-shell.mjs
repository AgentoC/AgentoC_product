import { spawn } from 'child_process'

function trimString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

async function runShellCommand(command, options = {}) {
  const normalizedCommand = trimString(command)
  if (!normalizedCommand) {
    throw new Error('Command is required')
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('bash', ['-lc', normalizedCommand], {
      env: {
        ...process.env,
        ...(options.env || {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timeoutHandle = null

    const settle = (error, value) => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (error) {
        rejectPromise(error)
        return
      }
      resolvePromise(value)
    }

    if (options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM')
        settle(new Error(`Command timed out after ${options.timeoutMs}ms: ${normalizedCommand}`))
      }, options.timeoutMs)
    }

    child.on('error', (error) => {
      settle(error)
    })

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('close', (code, signal) => {
      if (settled) return
      if (code !== 0) {
        settle(new Error(`Command failed (${code}${signal ? `/${signal}` : ''}): ${trimString(stderr) || trimString(stdout) || normalizedCommand}`))
        return
      }
      settle(null, { stdout, stderr, code, signal })
    })

    if (options.stdin !== undefined && options.stdin !== null) {
      child.stdin.end(String(options.stdin))
    } else {
      child.stdin.end()
    }
  })
}

async function runSay(text, ttsConfig) {
  if (!trimString(text)) return
  await new Promise((resolvePromise, rejectPromise) => {
    const args = []
    if (trimString(ttsConfig.voice)) {
      args.push('-v', trimString(ttsConfig.voice))
    }
    if (ttsConfig.rate) {
      args.push('-r', String(ttsConfig.rate))
    }
    args.push(text)

    const child = spawn('say', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    let stderr = ''
    let settled = false
    let timeoutHandle = null

    const settle = (error) => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (error) {
        rejectPromise(error)
        return
      }
      resolvePromise()
    }

    if (ttsConfig.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM')
        settle(new Error(`say timed out after ${ttsConfig.timeoutMs}ms`))
      }, ttsConfig.timeoutMs)
    }

    child.on('error', (error) => {
      settle(error)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('close', (code, signal) => {
      if (settled) return
      if (code !== 0) {
        settle(new Error(`say failed (${code}${signal ? `/${signal}` : ''}): ${trimString(stderr) || 'unknown error'}`))
        return
      }
      settle(null)
    })
  })
}

function parseCommandPayload(text) {
  const normalized = trimString(text)
  if (!normalized) return null
  try {
    const parsed = JSON.parse(normalized)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed
    }
  } catch {}
  return null
}

export {
  parseCommandPayload,
  runSay,
  runShellCommand,
}
