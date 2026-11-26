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
  // Vite answers 403 to a Host outside localhost and *.localhost. The e2e
  // objects host may not sit under the localhost apex (COMPAT_OBJECTS_HOST),
  // so scripts/e2e.sh names it here.
  server: {
    allowedHosts: process.env.SERVE_DEV_ALLOWED_HOSTS?.split(",").filter(Boolean),
  },
  ssr: {
    noExternal: ["@jsquash/jpeg", "@jsquash/png", "@jsquash/webp", "@jsquash/resize"],
  },
  optimizeDeps: {
    exclude: ["@jsquash/jpeg", "@jsquash/png", "@jsquash/webp", "@jsquash/resize"],
  },
});
