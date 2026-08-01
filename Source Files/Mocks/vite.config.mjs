import { resolve, join } from "path";
import { defineConfig } from "vite";
import stylelint from "vite-plugin-stylelint";
import { DynamicPublicDirectory } from "vite-multiple-assets";
import { NodePackageImporter } from "sass";

const mimeTypes = {
  ".glb": "model/gltf-binary",
  ".pbf": "application/vnd.mapbox-vector-tile"
};
const publicDirs = ["3D/public/**"];

export default defineConfig({
  appType: "mpa",
  server: {
    host: "127.0.0.1",
    publicDir: false,
    fs: {
      allow: ["../..", "../../static"]
    }
  },
  plugins: [
    stylelint({ build: true, dev: false, lintOnStart: true }),
    DynamicPublicDirectory(publicDirs, {
      ssr: false,
      mimeTypes
    })
  ],
  build: {
    target: "es2022",
    //target: "esnext",
    cssCodeSplit: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "3D/index.html")
      },
      output: {
        format: "esm",
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
    },
    postcss: {
      plugins: []
    }
  }
});
