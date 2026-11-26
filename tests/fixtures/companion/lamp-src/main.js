// A real Companion module, written the way module authors write them, for a lamp that does not exist.
// Skillfully's tests build it with Bitfocus's own tools and drop the package into a hub.
import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import net from 'node:net'
import fs from 'node:fs/promises'
import { exec } from 'node:child_process'
import path from 'node:path'

class Lamp extends InstanceBase {
	async init(config) {
		await this.configUpdated(config)
	}

	async destroy() {
		this.close()
	}

	getConfigFields() {
		return [
			{ type: 'textinput', id: 'host', label: 'Lamp address', default: '', width: 8 },
			{ type: 'number', id: 'port', label: 'Port', default: 7000, min: 1, max: 65535, width: 4 },
		]
	}

	async configUpdated(config) {
		this.config = config
		this.close()
		this.setActionDefinitions({
			on: { name: 'Turn on', options: [], callback: async () => this.send('on') },
			off: { name: 'Turn off', options: [], callback: async () => this.send('off') },
			level: {
				name: 'Set level',
				options: [{ type: 'number', id: 'level', label: 'Level', default: 50, min: 0, max: 100 }],
				callback: async (action) => this.send(`level ${Number(action.options.level)}`),
			},
			snoop: { name: 'Try to reach past the sandbox', options: [], callback: async () => this.snoop() },
			'bad name!': { name: 'An action whose id a key cannot hold', options: [], callback: async () => {} },
		})
		this.setVariableDefinitions([
			{ variableId: 'power', name: 'Power' },
			{ variableId: 'level', name: 'Level' },
			{ variableId: 'snoop', name: 'Sandbox test result' },
			{ variableId: 'Lamp_Model.v2', name: 'Model' },
		])
		this.setVariableValues({ power: 'unknown', level: '', snoop: '', 'Lamp_Model.v2': 'L-100' })
		if (!config.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'Lamp address not set')
			return
		}
		this.updateStatus(InstanceStatus.Connecting)
		this.connect()
	}

	connect() {
		const sock = net.connect(Number(this.config.port), this.config.host)
		this.sock = sock
		let buf = ''
		sock.on('connect', () => {
			this.updateStatus(InstanceStatus.Ok)
			sock.write('get\n')
		})
		sock.on('data', (d) => {
			buf += d
			let i
			while ((i = buf.indexOf('\n')) >= 0) {
				this.line(buf.slice(0, i))
				buf = buf.slice(i + 1)
			}
		})
		sock.on('error', (e) => {
			this.updateStatus(InstanceStatus.ConnectionFailure, e.message)
		})
		sock.on('close', () => {
			if (this.sock !== sock) return
			this.sock = null
			this.retry = setTimeout(() => this.connect(), 500)
		})
	}

	// The lamp says: power=on level=40
	line(text) {
		const values = {}
		for (const part of text.trim().split(/\s+/)) {
			const [key, value] = part.split('=')
			if (key === 'power') values.power = value
			if (key === 'level') values.level = Number(value)
		}
		this.setVariableValues(values)
	}

	send(command) {
		if (!this.sock) throw new Error('the lamp is not connected')
		this.sock.write(command + '\n')
	}

	close() {
		clearTimeout(this.retry)
		const sock = this.sock
		this.sock = null
		sock?.destroy()
	}

	// Everything a module should not be able to do. Each attempt reports what happened.
	async snoop() {
		const out = {}
		const attempt = async (name, fn) => {
			try {
				const got = await fn()
				out[name] = got === undefined || got === null || got === '' ? 'nothing' : 'got it'
			} catch (_e) {
				out[name] = 'refused'
			}
		}
		await attempt('file', () => fs.readFile(process.execPath).then((b) => b.length))
		await attempt('write', () =>
			fs.writeFile(path.join(path.dirname(process.env.MODULE_MANIFEST), 'snooped.txt'), 'x').then(() => 'written'),
		)
		await attempt('env', () => process.env.PATH)
		await attempt('envDirect', () => globalThis.Deno?.env.get('PATH'))
		await attempt('run', () => new Promise((res, rej) => exec('echo hi', (e, so) => (e ? rej(e) : res(so)))))
		await attempt(
			'net',
			() =>
				new Promise((res, rej) => {
					const s = net.connect(9, '192.0.2.1')
					s.on('connect', () => res('connected'))
					s.on('error', rej)
					setTimeout(() => rej(new Error('timeout')), 1500)
				}),
		)
		await attempt('fetch', () => fetch('https://example.com').then((r) => r.status))
		this.setVariableValues({ snoop: JSON.stringify(out) })
	}
}

runEntrypoint(Lamp, [])
