const path = require("path");
const { Compilation, sources, ProvidePlugin } = require("webpack");
const ESLintPlugin = require("eslint-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");

module.exports = {
    devtool: "source-map",
    mode: "production",
    entry: {
        sockdriveFat: "./src/sockdrive-fat.ts",
        sockdriveNative: "./src/sockdrive-native.ts",
        runTests: "./tests/run-tests.ts",
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: "ts-loader",
                exclude: /node_modules/,
            },
        ],
    },
    resolve: {
        extensions: [".tsx", ".ts", ".js"],
        fallback: {
            "process/browser": require.resolve("process/browser"),
            events: require.resolve("events/"),
            assert: require.resolve("assert/"),
            stream: require.resolve("stream-browserify"),
            buffer: require.resolve("buffer"),
        },
    },
    stats: {
        errorDetails: true,
    },
    output: {
        filename: "[name].js",
        path: path.resolve(__dirname, "dist"),
    },
    plugins: [
        {
            apply(compiler) {
                compiler.hooks.thisCompilation.tap("Replace", (compilation) => {
                    compilation.hooks.processAssets.tap(
                        {
                            name: "R_PLUGIN",
                            stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_HASH,
                        },
                        () => {
                            compilation.updateAsset(
                                "sockdriveNative.js",
                                new sources.RawSource(
                                    "R\"'''(" +
                                        compilation
                                            .getAsset("sockdriveNative.js")
                                            .source.source() +
                                        ")'''\"",
                                ),
                            );
                        },
                    );
                });
            },
        },
        new ProvidePlugin({
            process: "process/browser",
            Buffer: ["buffer", "Buffer"],
        }),
        new ESLintPlugin({
            fix: true,
            extensions: ["ts"],
            useEslintrc: false,
            overrideConfigFile: ".eslintrc.json",
        }),
        new HtmlWebpackPlugin({
            template: "tests/index.html",
        }),
    ],
    optimization: {
        minimize: true,
    },
};
