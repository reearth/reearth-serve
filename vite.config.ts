import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
  // jSquash ships .wasm files that the Worker imports as default modules.
  // Vite's dep-optimizer otherwise rewrites them to file:// URLs, which the
  // Workers runtime cannot fetch — generation throws "Fetch API cannot load
  // file://..." in dev. Excluding the package lets wrangler's WASM bundler
  // handle the imports directly.
  ssr: {
    noExternal: ["@jsquash/jpeg", "@jsquash/png", "@jsquash/webp", "@jsquash/resize"],
  },
  optimizeDeps: {
    exclude: ["@jsquash/jpeg", "@jsquash/png", "@jsquash/webp", "@jsquash/resize"],
  },
});
