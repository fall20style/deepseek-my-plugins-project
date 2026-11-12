# deepseek-my-plugin

A minimal [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin.
While it is installed, the Web UI background is `chocolate` (`#D2691E`).

**한국어 튜토리얼:** [TUTORIAL.md](./TUTORIAL.md) — 처음부터 다시 만들면서
플러그인 구조와 작성 방법을 익히는 단계별 가이드입니다.

**한국어 심화 문서:**

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — profile/bundle 합성, Host와
  Client 두 평면, 서비스·이벤트, 모듈 로더, 슬롯, 테마 토큰, 데이터 경로
- [docs/IMPLEMENTATION-GUIDE.md](./docs/IMPLEMENTATION-GUIDE.md) — 도구·서비스·
  설정·UI·커맨드·라우트를 붙이는 레시피, 패키징, 디버깅, 체크리스트

## Screenshots

The Web UI with the plugin enabled:

![Web UI with a chocolate background](docs/screenshots/01-web-ui-chocolate.jpeg)

With the plugin installed, **Plugins** shows an enabled entry. Toggling it off
restores the normal theme immediately, without uninstalling:

| Enabled | Disabled |
| --- | --- |
| ![deepseek-my-plugin enabled](docs/screenshots/02-plugins-on.jpeg) | ![deepseek-my-plugin disabled](docs/screenshots/03-plugins-off.jpeg) |

## Layout

```
deepseek-my-plugin/
├── package.json       # dsh.bundle + dsh.client manifests
├── cordis.patch.yml   # the Loader row this bundle contributes
├── src/
│   ├── index.ts       # host half (empty apply; makes the Loader row real)
│   └── client/
│       └── index.ts   # browser half (the theme override)
└── tsdown.config.ts   # host ESM entry + browser factory bundle
```

## How it works

The host half does nothing. Installing the bundle inserts a Loader row whose
name is the bare package name. The client module system scans enabled rows,
sees the package's `dsh.client` declaration, and serves `exports["./client"]`
to the browser.

The browser half waits for the `theme` service and calls
`ctx.theme.overrideTokens()`:

```ts
ctx.theme.overrideTokens('deepseek-my-plugin', {
  '--dsw-alias-bg-base': { light: 'chocolate', dark: 'chocolate' },
})
```

That stacks a token layer over the active light/dark palette. Uninstalling or
disabling the plugin removes the layer and restores the normal background.

## Build

```sh
pnpm install
pnpm run typecheck
pnpm run build
```

The built artifacts are committed under `lib/`, so a local install needs no
build step. The plugin can live anywhere on disk; it only needs the harness at
runtime.

## Install into a profile

Add the package to the Web profile. Pass the path to this directory (relative or
absolute), wherever you keep it:

```sh
dsh plugin --profile web add ../deepseek-my-plugins-project/deepseek-my-plugin
```

`add` only links the package into the profile; it does not enable the bundle
layer. Enable it in either way:

- Turn `deepseek-my-plugin` on in the Web UI's **Plugins** list, or
- add `"deepseek-my-plugin"` to `dsh.profile.bundles` in
  `$DSH_HOME/profiles/web/package.json`.

Verify the composed layer, then start the UI:

```sh
dsh --profile web --dump-config   # shows: # == deepseek-my-plugin
dsh web
```

The install is a pnpm link to this directory, so if you move the directory,
remove and re-add the plugin.

Then open the Web UI. The background is chocolate. To remove the plugin:

```sh
dsh plugin --profile web remove deepseek-my-plugin
```

## Extend it

- Change `BACKGROUND_COLOR` in `src/client/index.ts` to any CSS colour.
- Add more theme tokens to the same `overrideTokens` call (each needs both
  `light` and `dark` values).
- Add host-side behaviour in `src/index.ts` (tools, services, events).
