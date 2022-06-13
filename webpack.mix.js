const tailwind = require('tailwindcss');
const mix = require('laravel-mix');

process.env.MIX_BUILD_TIME = Date.now();

// global settings
mix
	.disableNotifications()
	.setResourceRoot('resources/js')
	.setPublicPath('dist');

// render js file
mix
	.js('resources/js/tmijs-cluster.js', 'dist/assets')
	.vue();

// render css
mix.sass('resources/style/tmijs-cluster.scss', 'dist/assets', {}, [ tailwind ]);

mix.override((config) => {
	config.output.chunkFilename = 'assets/[name].[contenthash].js';
});

if (mix.inProduction()) {
	mix.version();
}