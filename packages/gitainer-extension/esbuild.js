const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',

    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log('[watch] build finished');
        });
    },
};

const commonConfig = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    external: ['vscode'],
    logLevel: 'info',
    plugins: [esbuildProblemMatcherPlugin]
};

async function main() {
    try {
        const nodeCtx = await esbuild.context({
            ...commonConfig,
            platform: 'node',
            outfile: 'dist/node/extension.js'
        });

        const webCtx = await esbuild.context({
            ...commonConfig,
            platform: 'browser',
            outfile: 'dist/web/extension.js'
        });

        if (watch) {
            await Promise.all([nodeCtx.watch(), webCtx.watch()]);
        } else {
            await Promise.all([nodeCtx.rebuild(), webCtx.rebuild()]);
            await Promise.all([nodeCtx.dispose(), webCtx.dispose()]);
        }
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

main();
