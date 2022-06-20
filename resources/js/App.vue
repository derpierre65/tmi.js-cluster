<template>
	<div class="h-full min-h-full flex flex-col">
		<header class="pt-6 pb-4 bg-purple-900">
			<div class="container mx-auto flex gap-4 flex-col md:flex-row">
				<div class="flex-auto">
					<h1 class="text-4xl font-bold">tmi.js Cluster</h1>
					<h2 class="text-sm">Service Status</h2>
				</div>
				<div class="flex items-center">
					<a class="text-xl font-bold cursor-pointer" href="https://github.com/derpierre65/tmi.js-cluster/" target="_blank">Powered by tmi.js-cluster</a>
				</div>
			</div>
		</header>

		<main class="flex-auto container pt-4 mx-auto flex flex-col gap-4">
			<tmi-card>
				<template #title>Overview</template>

				<div class="flex w-full bg-stone-800 divide-x divide-stone-700" v-for="elements in globalMetricElements">
					<div class="w-1/4" v-for="element in elements" :key="element.title">
						<div class="p-4">
							<small class="text-lg">{{element.title}}</small>
							<div v-if="element.type === 'icon'" class="flex items-center mt-4">
								<div class="dot w-6 h-6 mr-2 flex-shrink-0" :class="element.class"></div>
								<h4 class="text-xl">{{element.value}}</h4>
							</div>
							<h4 v-else class="mt-4 font-medium text-2xl">
								{{formatNumber(element.value)}} {{element.suffix || ''}}
							</h4>
						</div>
					</div>
				</div>
			</tmi-card>

			<template v-if="supervisors !== null">
				<tmi-card v-for="supervisor in supervisors" :key="supervisor.id">
					<template #title>
						{{supervisor.id}} <small>- {{calculateUptime(supervisor.created_at)}}</small>
					</template>

					<template #header-right>
						<svg viewBox="0 0 20 20" class="fill-green-600 w-6 h-6" style="width: 1.5rem; height: 1.5rem;">
							<path
								d="M2.93 17.07A10 10 0 1 1 17.07 2.93 10 10 0 0 1 2.93 17.07zm12.73-1.41A8 8 0 1 0 4.34 4.34a8 8 0 0 0 11.32 11.32zM6.7 9.29L9 11.6l4.3-4.3 1.4 1.42L9 14.4l-3.7-3.7 1.4-1.42z"></path>
						</svg>
					</template>

					<table class="w-full">
						<thead>
						<tr>
							<th class="text-left">UUID</th>
							<th class="text-left">State</th>
							<th class="text-left">Last Ping</th>
							<th class="text-left">Uptime</th>
							<th class="text-right">Channels</th>
							<th class="text-right">Memory</th>
						</tr>
						</thead>
						<tbody>
						<tr v-for="process in supervisor.processes" :key="process.id">
							<td>{{process.id}}</td>
							<td>{{process.state}}</td>
							<td>{{calculateUptime(process.last_ping_at)}} ago</td>
							<td>{{calculateUptime(process.created_at)}}</td>
							<td class="text-right">{{formatNumber(process.metrics.channels || 0)}}</td>
							<td class="text-right">{{formatNumber(process.metrics.memory || 0)}} MB</td>
						</tr>
						</tbody>
					</table>
				</tmi-card>
			</template>
		</main>

		<footer class="text-center mb-4">
			<small>Copyright &copy; {{year}} derpierre65 & Contributors</small>
		</footer>
	</div>
</template>

<script>
import axios from 'axios';
import TmiCard from './components/TmiCard';

export default {
	components: { TmiCard },
	data() {
		return {
			supervisors: null,
			year: (new Date()).getFullYear(),
			globalMetrics: {
				messages: { title: 'IRC Message/s', value: 0 },
				commands: { title: 'IRC Commands/s', value: 0 },
				messagesProcessed: { title: 'IRC Messages Processed', value: 0 },
				commandsProcessed: { title: 'IRC Commands Processed', value: 0 },
				channels: { title: 'Channels', value: 0 },
				processes: { title: 'Processes', value: 0 },
				memory: { title: 'Memory', value: 0, suffix: 'MB' },
				status: { title: 'Status', value: 'Unknown', class: 'is-unknown', type: 'icon' },
			},
		};
	},
	created() {
		this.loadStatistics();

		window.setInterval(() => {
			this.loadStatistics();
		}, 5_000);
	},
	computed: {
		globalMetricElements() {
			const chunks = [];
			let globalMetrics = Object.values(this.globalMetrics);
			for (let i = 0; i < globalMetrics.length; i += 4) {
				chunks.push(globalMetrics.slice(i, i + 4));
			}

			return chunks;
		},
	},
	methods: {
		formatNumber(value, maxDigits = 0) {
			return parseFloat(value).toLocaleString('en', {
				minimumFractionDigits: 0,
				maximumFractionDigits: maxDigits,
			});
		},
		setStatus(status, error) {
			this.globalMetrics.status.class = 'is-' + status;

			if (status === 'ok') {
				this.globalMetrics.status.value = 'All systems operational';
			}
			else if (status === 'error') {
				this.globalMetrics.status.value = error || 'All systems down';
			}
			else if (status === 'warning') {
				this.globalMetrics.status.value = 'Some are down';
			}
		},
		loadStatistics() {
			axios
				.get('/statistics/')
				.then(({ data }) => {
					this.supervisors = data;
					this.setStatus('ok');

					let processes = 0;
					let channels = 0;
					let memory = 0;
					let rawMessages = 0;
					let messages = 0;
					for (const supervisor of this.supervisors) {
						processes += supervisor.processes.length;
						for (const process of supervisor.processes) {
							channels += process.metrics.channels || 0;
							memory += process.metrics.memory || 0;
							rawMessages = process.metrics.rawMessages;
							messages = process.metrics.messages;
						}
					}

					this.globalMetrics.messagesProcessed.value = messages;
					this.globalMetrics.commandsProcessed.value = rawMessages;
					this.globalMetrics.channels.value = channels;
					this.globalMetrics.processes.value = processes;
					this.globalMetrics.memory.value = memory;
				})
				.catch(() => {
					this.setStatus('error');
					console.error('could not update the statistics.');
				});
		},
		calculateUptime(createdAt) {
			const created = new Date(createdAt);
			const now = new Date();
			const uptime = [];

			let seconds = Math.floor((now - created) / 1_000);
			if (seconds > 60) {
				seconds = this.addUptimeValue(seconds, 86_400, uptime, 'day', 'days');
				seconds = this.addUptimeValue(seconds, 3_600, uptime, 'hour', 'hours');
				seconds = this.addUptimeValue(seconds, 60, uptime, 'minute', 'minutes');
			}
			else {
				uptime.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);
			}

			let popped = uptime.length > 2 ? uptime.pop() : '';

			return [uptime.join(', '), popped].filter((value) => value).join(' and ');
		},
		addUptimeValue(value, divider, uptime, singular, plural) {
			if (value >= divider) {
				const count = Math.floor(value / divider);
				uptime.push(`${count} ${count === 1 ? singular : plural}`);

				value -= count * divider;
			}

			return value;
		},
	},
};
</script>