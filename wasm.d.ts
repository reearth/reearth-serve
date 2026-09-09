// .wasm files imported in Workers code are bundled by wrangler/vite and surface
// as WebAssembly.Module values. There's no upstream type declaration, so
// declare a generic shape for both bare-specifier and relative-path imports.
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

