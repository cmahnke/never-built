import { resolve, join } from "path";
import { defineConfig } from "vite";
import eslint from "vite-plugin-eslint";
import stylelint from "vite-plugin-stylelint";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { DynamicPublicDirectory } from "vite-multiple-assets";
import { NodePackageImporter } from "sass";

const mimeTypes = { ".glb": "model/gltf-binary" };

export default defineConfig({
  server: {
    host: "127.0.0.1",
    proxy: {
      "/map/tiles": {
        target: "http://never-build.goettingen.xyz",
        changeOrigin: true,
        secure: true,
        ws: false,
        configure: (proxy, _options) => {
          proxy.on("error", (err, _req, _res) => {
            console.log("proxy error", err);
          });
          proxy.on("proxyReq", (proxyReq, req, _res) => {
            console.log("Sending Request to the Target:", req.method, req.url);
          });
          proxy.on("proxyRes", (proxyRes, req, _res) => {
            console.log("Received Response from the Target:", proxyRes.statusCode, req.url);
          });
        }
      }
    }
  },
  base: "./",
  plugins: [
    nodePolyfills(),
    {
      apply: "build"
    },
    stylelint({ build: true, dev: false, lintOnStart: true }),
    DynamicPublicDirectory(
      ["3D/public/**"],
      {
        ssr: false,
        mimeTypes
      }
    ),
  ],
  build: {
    //target: 'esnext',
    target: "es2020",
    commonjsOptions: { transformMixedEsModules: true },
    rollupOptions: {
      input: {
        main: resolve(__dirname, "3D/index.html")
      },
      output: {
        assetFileNames: `assets/[name].[ext]`
      }
    }
  },
  resolve: {
    preserveSymlinks: true,
    alias: [
      {
        find: /~(.+)/,
        replacement: join(process.cwd(), "node_modules/$1")
      }

    ]
  },
  optimizeDeps: {
    exclude: ["maplibre-gl", "three"]
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: "modern-compiler",
        importers: [new NodePackageImporter()]
      }
    }
  }
});
