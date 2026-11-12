# 구현 가이드 (Implementation Guide)

[ARCHITECTURE.md](./ARCHITECTURE.md)가 "왜 이렇게 생겼는가"를 설명한다면, 이 문서는
"그래서 어떻게 만드는가"를 다룹니다. `deepseek-my-plugin` 수준의 최소 플러그인부터
도구·서비스·설정·UI를 가진 복잡한 플러그인까지 단계적으로 확장할 수 있도록
실제 API와 체크리스트를 담았습니다.

- 기준 버전: `0.2.2-rc.1`
- 예제는 모두 저장소 밖(standalone) 패키지를 전제로 합니다.
- 하네스 소스 경로는 `$HARNESS`로 표기합니다.

---

## 0. 전제

플러그인은 하네스 저장소 밖에 있어도 됩니다. 필요한 것은 다음뿐입니다.

- Node.js 24.9 이상
- pnpm
- 하네스 npm 패키지(타입용, devDependency)
- 실행 시점의 `dsh`

저장소 밖 패키지가 지켜야 할 세 가지:

1. 하네스 패키지는 **type-only import + devDependency**로만 쓴다.
2. client 번들은 저장소의 `clientBundle` 프리셋을 import할 수 없으므로
   **tsdown 설정에서 직접 재현**한다.
3. prerelease 버전은 semver 범위로 매칭되지 않으므로 **정확한 버전으로 고정**한다
   (예: `"@deepseek-ai/dsh-client-ui-theme": "0.2.2-rc.1"`).

---

## 1. 캐노니컬 스캐폴드

복잡한 플러그인도 뼈대는 같습니다. 아래 다섯 파일을 먼저 정확히 맞추십시오.

### 1.1 `package.json`

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What this plugin does.",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/client.js",
    "lib/client.js.map",
    "cordis.patch.yml",
    "README.md"
  ],
  "engines": { "dsh": ">=0.2.0 <0.3.0" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  },
  "scripts": {
    "build": "tsdown",
    "watch": "tsdown --watch",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.1.0",
    "tsdown": "0.22.14",
    "typescript": "6.0.3"
  },
  "license": "MIT"
}
```

Host 절반이 필요 없어도 `main`과 빈 `apply`는 두십시오. Loader row가 있어야
client 절반이 발견됩니다.

### 1.2 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2024", "DOM"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src", "tsdown.config.ts"]
}
```

`types: []`는 Node 전역 타입이 브라우저 코드에 새어 들어오는 것을 막습니다.
Host 코드에서 Node API를 쓰려면 `@types/node`를 추가하고 `lib`/`types`를 조정하십시오.

### 1.3 `tsdown.config.ts` — 두 개의 출력

```ts
import { defineConfig } from 'tsdown'

/** Must match package.json `name`; the client loader keys bundles by it. */
const ID = 'my-plugin'

export default defineConfig([
  {
    name: `${ID}/host`,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: true,
    fixedExtension: false,
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    outputOptions: {
      entryFileNames: 'client.js',
      // The client module system evaluates this file as a factory that returns
      // the plugin module's exports, not as a standalone script.
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
```

이 세 줄(`banner` / `footer` / `intro`)이 저장소 프리셋의 핵심입니다.
`id`가 패키지 이름과 다르면 브라우저에서 "loaded without registering" 오류가 납니다.

### 1.4 `cordis.patch.yml`

```yaml
- insert:
    - id: my-plugin
      name: my-plugin
```

`id`는 프로필 안에서 유일해야 하고, `name`은 패키지 이름 그대로여야 합니다.
설정 기본값을 주려면 여기에 `config:`를 붙입니다.

```yaml
- insert:
    - id: my-plugin
      name: my-plugin
      config:
        retries: 5
```

### 1.5 최소 Host / Client

```ts
// src/index.ts
export const name = 'my-plugin'

export function apply(): void {}
```

```ts
// src/client/index.ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context): void {
  // UI 작업
}
```

### 1.6 빌드와 설치

```sh
pnpm install
pnpm run typecheck
pnpm run build
```

프로필에 링크하고 활성화합니다.

```sh
dsh plugin --profile web add ../my-plugin
```

`add`는 pnpm 의존성만 추가합니다. 번들 레이어를 켜려면
`$DSH_HOME/profiles/web/package.json`의 `dsh.profile.bundles`에 패키지 이름을
넣거나, Plugins UI에서 켜십시오. 확인:

```sh
dsh --profile web --dump-config
```

---

## 2. 빌드 산출물 읽기

`lib/client.js`는 대략 다음 모양이어야 합니다.

```js
window.__ModuleLoader__.load({ id: "my-plugin", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  // ... 번들 본문 ...
  return module.exports;
} });
```

체크할 것:

- 첫 줄의 `id`가 패키지 이름과 같은가
- `require("react")` 같은 외부 요청이 번들 안에 인라인되지 않았는가
- Node 내장 모듈(`node:fs` 등)이 들어가지 않았는가
- sourcemap이 같은 디렉터리에 있는가

브라우저에서 직접 확인:

```text
GET /plugins/??my-plugin/client.js&rev=<rev>     → 200 + JavaScript
```

404면 row가 비활성화됐거나, `dsh.client`/`exports["./client"]`/`lib/client.js` 중
하나가 빠진 것입니다.

---

## 3. 레시피

### 3.1 설정 가능한 플러그인

**Host: 스키마 + volatile 필드**

```ts
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  greeting: Volatile<string>
  retries: Volatile<number>
}

export const Config = z.object({
  greeting: z.string().default('Hello').volatile(),
  retries: z.number().min(0).default(3).volatile(),
})

export function apply(ctx: Context, config: Config): void {
  // Settings는 선택 서비스: 없어도 플러그인은 동작한다.
  // 자체 설정 페이지를 가질 때만 auto 생성을 끈다.
  ctx.inject(['settings'], (child) => {
    child.effect(
      () => child.settings.configure({ auto: false }, ctx.fiber),
      'my-plugin: settings policy',
    )
  })

  ctx.on('loader/volatile-update', () => {
    ctx.logger.info('greeting=%s retries=%d', config.greeting.get(), config.retries.get())
  })
}
```

핵심:

- `.volatile()`이 없으면 폼에 나오지 않습니다.
- `.get()`은 작업을 시작하는 시점에 읽습니다. 요청 하나가 일관된 스냅샷을
  필요로 하면 값을 한 번만 캡처하십시오.
- 교차 필드 검증은 `Config.check()`에 둡니다. 저장 전에 Host에서 실행됩니다.
- `inject = ['settings']`가 없어도 플러그인은 동작해야 합니다. 설정은 선택 기능으로
  취급하려면 `ctx.inject(['settings'], child => { ... })`를 쓰십시오.

**Client: 같은 namespace 구독**

```ts
export const inject = ['configForms']

export function apply(ctx: Context): void {
  const form = ctx.configForms.get<{ greeting: string; retries: number }>('my-plugin')

  ctx.effect(() => form.subscribe(() => {
    const snapshot = form.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.value === undefined) return
    render(snapshot.value.greeting)
  }), 'my-plugin: config form')

  // 쓰기
  void form.set('greeting', 'Hi')
}
```

`ConfigForm<T>`가 제공하는 것:

| 멤버 | 의미 |
| --- | --- |
| `getSnapshot()` | `{ status, value, base, user, revision, writable }` |
| `subscribe(fn)` | 스냅샷 교체 구독 |
| `set(field, value)` | 단일 필드 쓰기 (revision fence 유지) |
| `unset(field)` | 필드 제거 → 상속값으로 복귀 |
| `mutate(ops, revision?)` | 여러 편집을 한 번에 |

`namespace`는 **profile entry id**입니다. row id를 `my-plugin`으로 했다면 그 값입니다.

### 3.2 모델 도구 추가

`@deepseek-ai/dsh-tools`를 devDependency에 추가합니다.

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
      excited: { type: 'boolean' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      return args.excited ? `Hello, ${args.name}!!` : `Hello, ${args.name}.`
    },
  }))
}
```

계약 요약:

- `parameters`는 `defineTool`이 검증하고 `args` 타입을 추론합니다. DSL이 표현하지
  못하는 제약(비어 있지 않은 문자열, 양수 등)은 직접 검사하십시오.
- `execute`는 **하나의 canonical JSON 값**을 반환합니다. content block을 반환하거나
  사람이 읽는 문자열에서 id를 파싱하게 만들지 마십시오.
- `output.render`는 모델에게 보이는 표현입니다.
- 예외를 던지거나 스키마에 맞지 않는 값을 반환하면 `isError`가 됩니다.
- `exec.signal`을 존중하십시오.
- 긴 작업은 `ctx.jobs.start({ kind, label, owner: exec.agent, run })`으로 넘기고
  `{ kind: 'background', jobId }` 같은 핸들을 반환합니다.

정책은 도구 안에 넣지 말고 확장점으로 분리합니다.

| 목적 | 확장점 |
| --- | --- |
| allow/deny/ask 정책 | `tools/pre-execute` (waterfall) |
| 최종적이고 되돌릴 수 없는 거부 | `ctx.tools.guard()` |
| deadline/retry/metrics | `tools/execute` |
| 결과 변환/차단 | `tools/post-execute` |
| 결과 관측 | `tools/result` |

### 3.3 서비스 제공

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    myCache: MyCache
  }
}

export default class MyCache extends Service {
  static inject = ['sessions']

  private readonly values = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'myCache')
  }

  get(key: string): string | undefined {
    return this.values.get(key)
  }

  set(key: string, value: string): void {
    this.values.set(key, value)
  }
}
```

소비:

```ts
export const inject = ['myCache']

export function apply(ctx: Context): void {
  ctx.myCache.set('k', 'v')
}
```

선택 의존이면 `ctx.get('myCache')?.get('k')`를 씁니다. 서비스가 내려가면 이를
주입한 플러그인도 자동으로 내려갑니다. 그룹별로 다른 인스턴스가 필요하면
`cordis.yml`의 `isolate`를 사용합니다.

### 3.4 이벤트로 끼어들기

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'

export const name = 'my-policy'
export const inject = ['tools']

declare function isAllowed(tool: string): boolean

export function apply(ctx: Context): void {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!isAllowed(exec.name)) {
      return { kind: 'deny', reason: 'Denied by my-policy.' }
    }
    return next()
  })
}
```

- waterfall 리스너는 **반드시 `next()`를 호출**해야 합니다.
- 정리 가능한 정책은 waterfall, 최종 거부는 `guard()`가 맞습니다.
- 세션에 남는 `tool/result`는 Cordis 이벤트가 아닙니다. 필요하면 `session/event`를
  구독해 `event.type`을 보십시오.

### 3.5 사람용 슬래시 커맨드

```ts
export const inject = ['commands']

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'hello',
    description: 'Print a greeting without a model turn.',
    input: { hint: 'name' },
    async handler(invocation) {
      const name = invocation.rawInput.trim() || 'world'
      return { kind: 'success', text: `Hello, ${name}!` }
    },
  })
}
```

- `name`은 소문자, 선행 `/` 없이.
- 결과는 UI가 직접 렌더하는 `{ kind: 'success' | 'error' }`입니다.
  도구 결과나 세션 이벤트가 아닙니다.
- 첨부를 받으려면 `input: { hint, attachments: true }`를 선언하고
  `invocation.attachments`를 직접 처리합니다.

### 3.6 HTTP 엔드포인트

```ts
export const inject = ['webServer']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/my-plugin/api',
    handler(req, res) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, url: req.url }))
    },
  }), 'my-plugin: route')
}
```

- `kind: 'exact' | 'prefix'`.
- `path`는 절대 경로, trailing slash 없음.
- `(kind, path)`가 중복되면 throw합니다. prefix는 서로 겹치지 않게 잡으십시오.
- `ctx.webServer`는 인증이나 Origin 정책을 소유하지 않습니다. Host API 계층은
  `connection` 플러그인이 보호하지만, 여기서 직접 등록한 named route는 스스로
  인증·권한 정책을 설계해야 합니다.
- GET/HEAD만 필요하면 `resource: async (request) => new Response(...)` 형태가
  더 간단합니다.

### 3.7 UI 슬롯

**기존 슬롯에 행 추가**

```tsx
export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'my-plugin-row',
    order: 80,
  }, MyRow))
}
```

**플러그인 상세 페이지에 섹션 추가**

```tsx
ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
  name: 'plugins.detail.section',
  id: 'my-plugin-details',
  order: 50,
}, ({ subject }) => subject.kind === 'bundle' && subject.pkg === 'my-plugin'
  ? <MyDetails />
  : null))
```

**자식 슬롯 소유**

```tsx
ctx.slots.register({
  name: 'settings.section',
  id: 'my-section',
  order: 40,
  label: () => t('nav'),
  locale: NS,
  children: { 'my-plugin.panel': { kind: 'list', scope: 'root' } },
}, MySection)
```

`MySection`은 `renderSlot` prop으로 `my-plugin.panel`을 렌더합니다.
새 키는 `SlotMap` declaration merging으로 타입을 붙입니다.

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'my-plugin.panel': { kind: 'list'; scope: 'root'; owner: { children?: never } }
  }
}
```

규칙:

- 컴포넌트는 `ctx`를 받지 않습니다. 서비스는 `apply` 클로저에 두고 콜백으로 넘기십시오.
- `list`는 `id`가 필수이고 `order`로 정렬됩니다.
- 같은 `id`를 재사용하면 기존 셀을 **교체**합니다. 의도한 경우가 아니면 새 id를 쓰십시오.
- 선언되지 않은 슬롯에 등록하면 활성화가 실패합니다.

### 3.8 테마 토큰

```ts
export const inject = ['theme']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.theme.overrideTokens('my-plugin', {
    '--dsw-alias-bg-base': { light: '#fdf6e3', dark: '#101014' },
    '--dsw-alias-brand-primary': { light: '#b58900', dark: '#e0b341' },
  }), 'my-plugin: theme')
}
```

- 값은 반드시 `{ light, dark }`.
- `source`당 레이어 하나. 같은 source로 다시 호출하면 교체됩니다.
- 등록 해제 시 원래 값이 복원됩니다.
- 팔레트 전체를 바꾸려면 `ctx.theme.register({ id, colorScheme, tokens })`를 씁니다.

### 3.9 다국어

```ts
const NS = 'my-plugin'

const en = { nav: 'My Plugin', save: 'Save' }
const ko = { nav: '내 플러그인', save: '저장' }

export const inject = ['locale']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, ko }), 'my-plugin: locales')
  const t = ctx.locale.bind(NS)
  console.log(t('nav'))
}
```

슬롯 등록에 `locale: NS`를 주면 컴포넌트가 `t` prop을 받습니다.
언어 선택은 사용자 설정이 소유하므로 플러그인이 직접 언어를 고르지 않습니다.

### 3.10 키보드 단축키

```ts
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'

export const inject = ['shortcuts']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.shortcuts.register({
    id: 'my-plugin.toggle' as ShortcutCommandId,
    label: () => 'Toggle my panel',
    aliases: [],
    defaults: {
      'web:windows': { code: 'KeyK', modifiers: ['control', 'shift'] },
      'web:macos': { code: 'KeyK', modifiers: ['meta', 'shift'] },
    },
    regions: ['page'],
    modals: [],
    resolve: () => ({ status: 'handled', run: () => togglePanel() }),
  }), 'my-plugin: shortcut')
}
```

`ShortcutProfile`은 `` `${runtime}:${platform}` ``입니다. `resolve`는 동기 DOM
컨텍스트를 받고 `handled` / `blocked` / `pass` 중 하나를 반환합니다.
중복 id와 겹치는 기본 바인딩은 throw합니다.

### 3.11 Host↔Client Remote API

```ts
export class NotesController extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'notesController', { namespace: 'notes' })
  }

  @Remote('list')
  async remoteExportList(agent: Agent, signal: AbortSignal): Promise<NoteRow[]> {
    return this.list(agent, signal)
  }
}
```

```ts
export const inject = ['remote', 'remote.notes']

const result = await ctx.remote.notes.list()
if (!result.ok) {
  if (result.error.code === 'note/not-found') return []
  throw result.error
}
```

**저장소 밖에서의 현실적인 제약:** `@Remote`는 빌드 타임 코드 생성
(`lib/typert.*.js`, `.d.ts`)을 전제로 합니다. 이 파이프라인은 하네스 저장소의
스크립트에 묶여 있어 standalone 패키지가 그대로 재현하기 어렵습니다.

우선순위:

1. 정적 데이터라면 `webserver/index-inject` 또는 단순 HTTP 라우트.
2. 요청/응답이라면 `ctx.webServer.register` + `fetch`.
3. 타입 있는 RPC가 꼭 필요하면 저장소 안에서 개발하거나, 생성 산출물을 함께
   배포하는 방법을 검토.

실패는 `RemoteError` 하나와 코드 테이블로 표현하고, 호출부는 `instanceof`가 아니라
`code`로 분기합니다. Remote 호출은 reject하지 않고 `RemoteResult<T>`를 반환합니다.

---

## 4. 풀스택 예제 설계도: "테마 프리셋" 플러그인

세 가지 기능을 가진 플러그인을 가정합니다.

1. Host Config로 프리셋 목록을 정의한다.
2. `/theme <name>` 커맨드로 즉시 전환한다.
3. Plugins 상세 페이지에 현재 프리셋을 보여준다.

구성:

```text
src/
├── index.ts              # Config + commands + service
└── client/
    ├── index.ts          # slots + configForms + theme
    └── PresetBadge.tsx
```

Host:

```ts
export interface Config {
  presets: Record<string, Record<string, { light: string; dark: string }>>
  active: Volatile<string>
}

export const Config = z.object({
  presets: z.dict(z.dict(z.object({
    light: z.string(), dark: z.string(),
  }))).default({}),
  active: z.string().default('default').volatile(),
})

export const inject = ['commands', 'settings']

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), 'preset: policy')

  ctx.commands.register({
    name: 'theme',
    description: 'Switch the UI theme preset.',
    input: { hint: 'preset name' },
    async handler(invocation) {
      const name = invocation.rawInput.trim()
      if (!(name in config.presets)) return { kind: 'error', text: `unknown preset: ${name}` }
      // namespace는 profile entry id다. 이 플러그인의 row id가 'my-theme-preset'이어야 한다.
      await ctx.settings.update('my-theme-preset', { active: name })
      return { kind: 'success', text: `theme → ${name}` }
    },
  })
}
```

Client:

```ts
export const inject = ['configForms', 'theme', 'slots']

export function apply(ctx: Context): void {
  const form = ctx.configForms.get<ThemeConfig>('my-theme-preset')

  ctx.effect(() => {
    let dispose: (() => void) | undefined
    const off = form.subscribe(() => {
      const snapshot = form.getSnapshot()
      if (snapshot.status !== 'ready' || !snapshot.value) return
      const preset = snapshot.value.presets[snapshot.value.active]
      if (!preset) return
      dispose?.()
      dispose = ctx.theme.overrideTokens('my-theme-preset', preset)
    })
    return () => { off(); dispose?.() }
  }, 'preset: apply')

  ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
    name: 'plugins.detail.section',
    id: 'my-theme-preset',
    order: 60,
  }, PresetBadge))
}
```

이 설계에서 배울 점:

- **설정의 단일 출처는 Host Config**입니다. Client는 `configForms`로 구독만 합니다.
- 토큰 레이어는 source 하나로 관리하고, 교체 시 이전 disposer를 먼저 호출합니다.
- 커맨드는 모델 턴을 만들지 않고 즉시 UI 결과를 반환합니다.
- 상세 페이지 UI는 슬롯으로만 붙고, 다른 플러그인을 import하지 않습니다.

---

## 5. 패키징 심화

### 5.1 `exports`와 타입

배포용으로 타입을 제공하려면:

```json
"exports": {
  ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
}
```

tsdown에서 `dts: true`로 켜고 `lib/types`를 `files`에 포함합니다. 사내/로컬
플러그인이라면 `dts: false`로 두고 `lib/`만 커밋해도 충분합니다.

### 5.2 CSS

저장소 프리셋은 `x.module.css`를 해시된 클래스 맵 + 스타일 주입으로 컴파일합니다.
저장소 밖에서는 다음 중 하나를 선택하십시오.

1. 인라인 `style` 객체 (가장 단순, 테마 토큰은 `var(--dsw-...)`로 사용).
2. `ctx.effect`로 `<style>` 요소를 추가하고 정리 시 제거.

```ts
ctx.effect(() => {
  const el = document.createElement('style')
  el.textContent = `.my-panel { background: var(--dsw-alias-bg-layer-1); }`
  document.head.append(el)
  return () => el.remove()
}, 'my-plugin: styles')
```

테마 토큰을 쓰면 light/dark가 자동으로 따라옵니다. 하드코딩된 색을 피하십시오.

### 5.3 이미지/자산

`"./assets/*": "./lib/assets/*"` export와 `/plugins/<pkg>/assets/<path>` 라우트를
쓸 수 있지만, 파일 이름에 내용 리비전을 넣는 규칙을 직접 맞춰야 합니다.
이미지가 몇 개 안 된다면 코드에서 경로 문자열을 쓰거나 data URL을 쓰는 편이
유지보수하기 쉽습니다.

### 5.4 의존성

- 런타임에 하네스가 제공하는 것은 `peerDependencies` + devDependency로.
- 순수 유틸리티는 번들에 인라인해도 됩니다(작을 때).
- client 번들에 `react`, `zod`, `@deepseek-ai/cordis`를 넣지 마십시오.
  베이스라인과 중복되어 React가 두 벌이 되는 사고가 납니다.

### 5.5 버전 호환

- `engines.dsh`가 있으면 그것만 검사됩니다.
- prerelease는 범위 매칭이 까다로우므로 정확한 버전을 쓰십시오.
- 호환되지 않는 번들은 부팅 시 **조용히 skip**되고 `skippedBundles`에 보고됩니다.
  `--dump-config`에 row가 안 보이면 먼저 이 가능성을 의심하십시오.

---

## 6. 디버깅

### 6.1 합성 확인

```sh
dsh --profile web --dump-config
```

- `# == <bundle>` 주석으로 레이어 경계를 확인
- row `id`/`name`/`config` 확인
- `disabled` 여부 확인
- `--dump-config-schema`는 각 모듈을 **import**하므로 신뢰하는 프로필에만 사용

### 6.2 설치/활성 상태

```sh
dsh plugin --profile web why my-plugin
```

프로필 `package.json`에서 두 곳을 봅니다.

- `dependencies`에 있는가 → 설치됨
- `dsh.profile.bundles`에 있는가 → 활성화됨

### 6.3 브라우저

- 콘솔의 boot audit 메시지: 모듈 로드 실패, 등록 실패, 의존성 cascade
- Network: `/plugins/??<pkg>/client.js&rev=...` 상태 코드
- 토큰 확인:

```js
getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base')
getComputedStyle(document.body).backgroundColor
```

- 플러그인 on/off는 Plugins UI에서 즉시 확인할 수 있습니다. 끄면 row가 제거되고
  effect가 정리되어 원래 테마로 돌아옵니다.

### 6.4 서버

- stderr의 라벨링된 시작 진단(실패한 플러그인, 대기 중인 서비스)
- `ctx.logger` 사용: `ctx.logger.info('...')`
- `apply` 밖 unhandled rejection은 프로세스를 죽입니다. 스택을 먼저 보십시오.

### 6.5 타입

```sh
pnpm run typecheck
```

- 서비스 타입은 `declare module '@deepseek-ai/cordis'` 병합이 있어야 보입니다.
- 다른 client 플러그인의 `ctx` 확장은 `import type {} from '...'`로 가져옵니다.
- 값 import는 번들 순수성 게이트에 걸릴 수 있으므로 타입만 가져오십시오.

### 6.6 개발 루프

```sh
pnpm run watch        # tsdown watch
dsh web               # 또는 pnpm dsh web (소스 체크아웃)
```

- Host 코드 변경: 프로필 재합성/HMR 또는 `dsh web` 재시작
- Client 코드 변경: `lib/client.js` rev가 바뀌면 열린 페이지가 새 번들을 로드
- 페이지가 이전 Host release에 묶여 있으면 새로고침이 필요합니다

---

## 7. 테스트 전략

플러그인 크기에 따라 최소한 다음을 확인합니다.

| 수준 | 확인 내용 |
| --- | --- |
| 정적 | `tsc --noEmit`, 빌드 산출물 존재 |
| 합성 | `--dump-config`에 row가 보이고 `disabled`가 아님 |
| Host 동작 | 도구/커맨드/라우트를 실제 `dsh`에서 호출 |
| Client 동작 | 토큰/슬롯/설정이 브라우저에서 기대대로 렌더 |
| 수명주기 | on/off 토글 후 부작용이 남지 않음 |
| 실패 | 잘못된 설정이 부팅을 망가뜨리지 않는지(optional) |

수명주기 테스트는 특히 중요합니다. 등록을 disposer로 감싸지 않으면
토글/HMR 후 리스너가 중복됩니다.

```ts
// 나쁨: 토글할 때마다 누적
ctx.on('tools/result', handler)

// 좋음: fiber가 내려가면 자동 해제
ctx.effect(() => {
  const off = subscribe(handler)
  return off
}, 'my-plugin: subscription')
```

---

## 8. 체크리스트

### Host-only 플러그인

- [ ] `main`이 ESM 진입점을 가리킨다
- [ ] `cordis.patch.yml`의 `name`이 패키지 이름이다
- [ ] `apply`가 동기/비동기 예외를 밖으로 던지지 않는다
- [ ] 모든 등록이 `ctx.effect` 또는 레지스트리 disposer로 정리된다
- [ ] `inject`에 필수 서비스가 선언되어 있다
- [ ] 설정 필드는 `.volatile()`이다
- [ ] 장기 작업은 `ctx.jobs` 또는 소유된 취소 신호를 쓴다

### Client-only 플러그인

- [ ] `dsh.client.platform === 'web'`
- [ ] `exports["./client"]`가 존재한다
- [ ] 번들 `id` === 패키지 이름
- [ ] `banner`/`footer`/`intro`가 factory 형식을 만든다
- [ ] Node 내장 모듈을 쓰지 않는다
- [ ] 공유 모듈을 인라인하지 않는다
- [ ] 슬롯/테마/설정 등록이 `ctx.effect`로 정리된다
- [ ] `overrideTokens` 값이 `{ light, dark }` 쌍이다

### 풀스택 플러그인

- [ ] Host row가 **bare 패키지 이름**이다
- [ ] Host Config와 client `configForms`의 namespace가 entry id와 같다
- [ ] client가 Host 도구 구현을 import하지 않는다
- [ ] 세션에 남아야 할 사실은 세션 이벤트로 기록한다
- [ ] on/off 토글 후 UI와 리스너가 깨끗하다
- [ ] `lib/`이 커밋되어 설치자가 빌드하지 않아도 된다

---

## 9. 자주 깨지는 지점

| 증상 | 원인 | 해결 |
| --- | --- | --- |
| 배경이 안 바뀐다 | row 비활성 / client 절반 미발견 | `--dump-config`, `bundles`, bare name 확인 |
| "loaded without registering" | 번들 `id` 불일치 | tsdown `ID`를 패키지 이름과 일치 |
| 플러그인이 목록에 안 보인다 | `dsh.bundle.patch` 누락/경로 오류 | `dsh.bundle`과 patch 파일 확인 |
| client만 죽는다 | Node 내장 모듈/`process` 사용 | 브라우저 코드 분리 |
| React hook 오류 | React가 두 벌 | `react`를 external로, 인라인 금지 |
| 테마가 일부만 바뀐다 | 토큰 이름 오타 | `--dsw-*` 철자와 `{light,dark}` 확인 |
| 설정이 폼에 없다 | `.volatile()` 누락 | 스키마 필드에 volatile 추가 |
| 설정 저장이 거부된다 | 상위 레이어가 덮고 있음 | home patch/CLI overlay 우선순위 확인 |
| 토글 후 리스너 중복 | disposer 미등록 | `ctx.effect`로 감싸기 |
| HMR 후 옛 코드가 돈다 | 페이지가 이전 release | 새로고침 |
| 프로세스가 갑자기 죽는다 | apply 밖 unhandled rejection | 비동기 소유권 정리 |
| `invalid config` | patch가 빈 파일 | `[]`로 비활성화 |
| prerelease 설치 실패 | `^0.2.2-rc.1` 불일치 | 정확한 버전 고정 |
| 링크가 깨졌다 | 디렉터리 이동 | `plugin remove` → `add` |

---

## 10. 참고 소스 맵

| 알고 싶은 것 | 파일 |
| --- | --- |
| 최소 플러그인 | `docs/user/develop/basic/index.md` |
| Config 스키마 | `docs/user/develop/basic/config.md` |
| 도구 작성 | `docs/cookbook/adding-a-tool.md` |
| 설정 카드/volatile | `docs/cookbook/adding-a-settings-card.md` |
| 확장 형태 모음 | `docs/cookbook/extension-cookbook.md` |
| Remote API | `docs/cookbook/adding-a-remote-api.md` |
| 패키징/설치 | `docs/user/develop/basic/publish.md` |
| 슬롯 | `docs/subsystems/slots.md` |
| 클라이언트 모듈 | `docs/subsystems/client-modules.md` |
| Web Client | `docs/subsystems/web-client.md` |
| 커맨드 | `docs/subsystems/commands.md` |
| 도구 파이프라인 | `docs/subsystems/tools.md` |
| 설정 | `docs/subsystems/settings.md` |
| 테마 구현 | `packages/client/ui-theme/src/client/index.ts` |
| 설정 UI 구현 | `packages/client/ui-settings-plugins/src/client/index.ts` |
| client 빌드 프리셋 | `packages/client/tsdown.client.ts` |
| 공유 모듈 | `packages/client/web/src/platform.ts` |

이 문서의 코드는 계약을 보여주기 위한 최소 예제입니다. 실제 필드 이름과 옵션은
항상 해당 버전의 타입과 생성된 `cordis-surface`를 기준으로 확인하십시오.
