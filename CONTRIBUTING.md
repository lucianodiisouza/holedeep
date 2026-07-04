# Contributing to holedeep

Thanks for wanting to poke at the black hole. This is a small, fun project —
issues and PRs are welcome.

## Getting set up

You'll need [Node](https://nodejs.org/) and the
[Rust toolchain](https://www.rust-lang.org/tools/install), plus the
[Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev
```

Right now the live-capture path is macOS-only (it uses ScreenCaptureKit via
`scap`). The timer, overlay, and shader are cross-platform; the capture layer
is the part that needs per-OS work.

## Working on the shader

You don't need to trigger real breaks to iterate on the visuals. Run the
frontend on its own and open the overlay's browser demo mode, which renders
the hole over a synthetic desktop on a loop:

```sh
npm run dev
# then open http://localhost:1420/overlay.html
```

The shader lives in [`src/overlay/shader.ts`](src/overlay/shader.ts). The
untouched original it was ported from is in
[`shaders/reference/`](shaders/reference/) — keep that file pristine so the
diff against upstream stays readable.

## Before opening a PR

- `npm run build` should pass (runs `tsc` + `vite build`).
- `cargo fmt` and `cargo check` inside `src-tauri/` should be clean.
- Keep commits focused and describe the *why*, not just the *what*.

## Licensing

By contributing you agree your work is released under the project's
[MIT license](LICENSE). The ported shader carries its own upstream MIT
attribution — please preserve it.
