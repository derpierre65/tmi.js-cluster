<template>
	<div>
		<div class="bg-purple-900 p-2 text-lg font-bold flex items-center gap-2">
			<slot name="header-left" />

			<h5 class="flex-auto"><slot name="title" /></h5>

			<slot name="header-right" />
		</div>
		<div class="w-full divide-y divide-stone-700">
			<slot />
		</div>
	</div>
</template>

<script>
export default {
	name: 'TmiCard',
};
</script>