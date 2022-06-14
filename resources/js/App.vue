<template>
	<div class="h-full min-h-full">
		<header class="bg-purple-900 pt-14 pb-24">
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

		<main class="container mx-auto -mt-14">
			<div class="bg-purple-800 rounded-lg p-4 md:p-8 shadow-xl mb-10">
				<div class="flex flex-col text-center md:text-left md:flex-row md:items-center">
					<div class="dot is-big mx-auto md:ml-0 md:mr-8 is-ok"></div>
					<div class="text-3xl font-bold mt-4 md:mt-0">
						<span>All systems</span>
						<span class="text-green-500">operational</span>
					</div>
				</div>
			</div>

			<template v-if="false">
				<h2 class="text-3xl font-bold mb-4">Cluster Metrics</h2>
				<div class="bg-purple-800 rounded-lg p-4 md:p-8 shadow-xl mb-10">
					<div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
						<div v-for="i in 8" class="bg-stone-800 p-4 rounded-lg flex-1">
							<div>
								<h4 class="text-xl font-bold">45</h4>
								<h5 class="text-lg text-neutral-300">IRC Messages/s</h5>
							</div>
						</div>
					</div>
				</div>
			</template>

			<h2 class="text-3xl font-bold mb-4">Supervisors</h2>
			<template v-if="supervisors === null">
				<div class="rounded-lg shadow-xl mb-8" v-for="supervisor in 3" :key="supervisor">
					<table class="w-full">
						<thead class="font-bold text-lg bg-purple-700 p-2">
						<tr>
							<th class="text-left" colspan="5">
								<div class="bg-stone-900 rounded-lg h-6 w-1/3" />
							</th>
						</tr>
						</thead>
						<thead>
						<tr>
							<th class="text-left">State</th>
							<th class="text-left">UUID</th>
							<th class="text-left">Last Ping</th>
							<th class="text-left">Uptime</th>
							<th class="text-right">Channels</th>
							<th class="text-right">Memory</th>
						</tr>
						</thead>
						<tbody>
						<tr v-for="row in 6" :key="row">
							<td v-for="col in 6" :key="col">
								<div class="bg-stone-900 rounded-lg h-6 w-full" />
							</td>
						</tr>
						</tbody>
					</table>
				</div>
			</template>
			<div v-else class="rounded-lg shadow-xl mb-8" v-for="supervisor in supervisors" :key="supervisor.id">
				<table class="w-full">
					<thead class="font-bold text-lg bg-purple-700 p-2">
					<tr>
						<th class="text-left" colspan="5">
							<strong>{{supervisor.id}}</strong> <small>- {{calculateUptime(supervisor.created_at)}}</small>
						</th>
					</tr>
					</thead>
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
			</div>
		</main>

		<footer class="text-center mb-4">
			<small>Copyright &copy; {{ year }} derpierre65 & Contributors</small>
		</footer>
	</div>
</template>

<script>
import axios from 'axios';

export default {
	data() {
		return {
			supervisors: null,
			year: (new Date()).getFullYear(),
		};
	},
	created() {
		this.loadStatistics();

		window.setInterval(() => {
			this.loadStatistics();
		}, 3_000);
	},
	methods: {
		formatNumber(value, maxDigits = 0) {
			return parseFloat(value).toLocaleString('en', {
				minimumFractionDigits: 0,
				maximumFractionDigits: maxDigits,
			});
		},
		loadStatistics() {
			axios
				.get('/statistics/')
				.then(({ data }) => {
					this.supervisors = data;
				})
				.catch(() => {
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