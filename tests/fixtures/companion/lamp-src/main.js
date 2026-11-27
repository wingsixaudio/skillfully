// A real Companion module, written the way module authors write them, for a lamp that does not exist.
// Skillfully's tests build it with Bitfocus's own tools and drop the package into a hub.
import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'
import net from 'node:net'
import fs from 'node:fs/promises'
import cp, { exec } from 'node:child_process'
import os from 'node:os'
import fsNow from 'node:fs'
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
			// Companion fills this in by searching the network. The hub does not search, and does not show it.
			{ type: 'bonjour-device', id: 'bonjour_host', label: 'Find the lamp', width: 6 },
			// The module says how an address is written: numbers, for this lamp. What is typed is held to that.
			{ type: 'textinput', id: 'host', label: 'Lamp address', default: '', width: 8, regex: '/^\\d{1,3}(\\.\\d{1,3}){3}$/' },
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
			lookup: { name: 'Ask about the computer, the way libraries do', options: [], callback: async () => this.lookup() },
			'bad name!': { name: 'An action whose id a key cannot hold', options: [], callback: async () => {} },
		})
		// Ready-made buttons, the way a module offers them to Companion. Only what one press does is used
		// by the hub: the looks are Companion's, and the last three are ones the hub has to leave out.
		const look = { text: '', size: 'auto', color: 0xffffff, bgcolor: 0x000000 }
		const press = (actionId, options = {}) => [{ down: [{ actionId, options }], up: [] }]
		this.setPresetDefinitions({
			lamp_on: { type: 'button', category: 'Power', name: 'Lamp on', style: look, steps: press('on'), feedbacks: [] },
			lamp_off: { type: 'button', category: 'Power', name: 'Lamp off', style: look, steps: press('off'), feedbacks: [] },
			full: { type: 'button', category: 'Levels', name: 'Full <b>brightness</b>', style: look, steps: press('level', { level: 100 }), feedbacks: [] },
			half: { type: 'button', category: 'Levels', name: 'Half brightness', style: look, steps: press('level', { level: 50 }), feedbacks: [] },
			both: { type: 'button', category: 'Power', name: 'Two things at once', style: look, steps: [{ down: [{ actionId: 'on', options: {} }, { actionId: 'level', options: { level: 10 } }], up: [] }], feedbacks: [] },
			ghost: { type: 'button', category: 'Power', name: 'An action that is not there', style: look, steps: press('no-such-action'), feedbacks: [] },
			'bad name!': { type: 'button', category: 'Power', name: 'A button whose id a key cannot hold', style: look, steps: press('on'), feedbacks: [] },
		})
		this.setVariableDefinitions([
			{ variableId: 'power', name: 'Power' },
			{ variableId: 'level', name: 'Level' },
			{ variableId: 'snoop', name: 'Sandbox test result' },
			{ variableId: 'lookup', name: 'What the computer said about itself' },
			{ variableId: 'Lamp_Model.v2', name: 'Model' },
		])
		this.setVariableValues({ power: 'unknown', level: '', snoop: '', lookup: '', 'Lamp_Model.v2': 'L-100' })
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

	// What libraries do to learn about the computer they are on: run a program from inside a callback, where
	// nothing can catch a refusal, and ask the system about itself. Written with no care taken, as they are.
	lookup() {
		setTimeout(() => {
			cp.exec('arp -a /a/secret/argument', (err) => {
				this.setVariableValues({
					lookup: JSON.stringify({
						run: err ? err.code : 'ran',
						name: os.hostname(),
						release: os.release(),
						cards: Object.keys(os.networkInterfaces()).length,
						user: os.userInfo().username,
						elsewhere: fsNow.existsSync('/etc/hosts'),
						own: fsNow.existsSync(process.env.MODULE_MANIFEST),
						found: this.config.bonjour_host ?? null,
					}),
				})
			})
		}, 0)
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
