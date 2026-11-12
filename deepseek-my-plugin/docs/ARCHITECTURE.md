# SW 구조 (Architecture)

이 문서는 `deepseek-my-plugin` 하나를 설명하는 문서가 아니라, **도구·서비스·설정·UI를
가진 복잡한 플러그인을 설계할 때 필요한 DeepSeek Harness의 구조**를 정리한 문서입니다.

- 기준 버전: `0.2.2-rc.1`
- 경로 표기: 하네스 체크아웃을 `$HARNESS`, 하네스 홈을 `$DSH_HOME`(`~/.dsh`)으로 씁니다.
- 이 저장소의 플러그인은 `deepseek-my-plugin/`에 있습니다.

관련 문서:

- [TUTORIAL.md](../TUTORIAL.md) — 이 플러그인을 처음부터 만드는 단계별 가이드
- [IMPLEMENTATION-GUIDE.md](./IMPLEMENTATION-GUIDE.md) — 실제 작성 레시피와 체크리스트
- [PLUGIN_MODEL.md](./PLUGIN_MODEL.md) — 에이전트 코어와 플러그인의 통신 모델,
  Cordis의 네 역할, 턴/스텝·툴 파이프라인 개입 지점

---

## 1. 한눈에 보는 런타임 지형

`dsh`에는 수정해야 할 "핵심 코어"가 없습니다. 모델 어댑터, 도구 레지스트리, 세션 로그,
에이전트 루프까지 전부 플러그인이고, 우리는 그 옆에 플러그인을 하나 더 얹습니다.
등록은 모두 **effect**이므로 플러그인이 내려가면 자동으로 풀립니다.

```text
dsh (launcher, apps/cli)
 │
 ├─ profile 선택            $DSH_HOME/profiles/web
 │    ├─ package.json       dsh.profile.bundles (순서 있는 번들 목록) + 설치된 패키지
 │    ├─ cordis.yml          빈 엔트리 리스트 (합성의 시작점)
 │    └─ cordis.patch.yml    사용자 패치 레이어
 │
 ├─ layer 합성
 │    1) bundles (나열된 순서대로)
 │    2) profile의 cordis.patch.yml
 │    3) home의 cordis.patch.yml
 │    4) --patch 오버레이
 │
 ├─ Cordis Loader            entry row 목록 = 플러그인 트리
 │    ├─ host plugin fiber (Node)
 │    │    ├─ ctx.tools / ctx.commands / ctx.webServer / ctx.settings ...
 │    │    └─ @deepseek-ai/dsh-client-modules  (ctx.clientModules)
 │    │
 │    └─ web app (dsh-web-app 번들)
 │         ├─ HTTP:  GET /                → index + 부트 그래프 주입
 │         ├─ HTTP:  GET /plugins/??<pkg>/client.js,<pkg2>/client.js&rev=...
 │         └─ browser
 │              └─ window.__DSH_BOOT__ → 모듈 로더 → client plugin fiber
 │                   └─ ctx.slots → React 트리
 │
 └─ 브라우저 페이지는 열려 있는 동안 Host의 그래프 변경(HMR)을 따라간다.
```

핵심은 **평면이 두 개**라는 점입니다.

| | Host 평면 | Client 평면 |
| --- | --- | --- |
| 실행 위치 | Node.js (`dsh` 프로세스) | 브라우저 문서 |
| 진입점 | `package.json` `main` → `lib/index.js` | `exports["./client"]` → `lib/client.js` |
| 누가 로드하나 | Cordis Loader (entry row) | client module system (boot graph) |
| 플러그인 형태 | ESM 모듈, `apply(ctx, config)` | lazy-CJS factory → `apply(ctx)` |
| 의존성 선언 | `export const inject = ['tools']` | 같은 문법 + `dsh.client.inject`(모듈 도착 순서) |
| 정리 | `ctx.effect` / 반환된 disposer | 동일 |
| 실패 처리 | optional은 경고, required는 부팅 중단 | 부트 감사에서 보고, 나머지는 계속 |

우리 플러그인은 Host 절반이 비어 있고 Client 절반만 일합니다. 그래도 Host row가
필요한 이유는, **client 절반이 Loader row를 통해 발견되기** 때문입니다.

---

## 2. Profile과 레이어

### 2.1 Profile이란

Profile은 "이 설치가 어떤 앱 표면을 제공하는가"를 정하는 **이름 붙은 합성**입니다.
`web`, `headless`, `sdk`, `sdk-minimal`, `acp`가 템플릿으로 배포됩니다.

```text
$DSH_HOME/profiles/web/
├── package.json        # dsh.profile.bundles + dependencies
├── cordis.yml          # [] (합성 결과가 아니라 시작점)
├── cordis.patch.yml    # 사용자 패치
├── pnpm-lock.yaml
├── node_modules/
├── compatibility.json  # (선택) 정확한 버전 예외
└── .plugin-manager/    # 패키지 작업 로그
```

`package.json`의 두 부분은 역할이 다릅니다.

```jsonc
{
  "dependencies": {
    // 설치된 패키지. 여기에만 있고 bundles에 없으면 "설치됐지만 비활성".
    "deepseek-my-plugin": "link:C:/.../deepseek-my-plugin"
  },
  "dsh": {
    "profile": {
      // 이 목록에 있는 패키지의 dsh.bundle 레이어가 부팅 시 합성된다.
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dshmarket",
        "deepseek-my-plugin"
      ]
    }
  }
}
```

> **중요:** `dsh plugin --profile web add <path>`는 pnpm 의존성만 추가합니다.
> 번들 레이어를 켜려면 `dsh.profile.bundles`에 패키지 이름이 있어야 합니다.
> UI에서 설치·활성화하면 이 목록에 기록되고, 로컬 개발에서는 직접 `bundles`에
> 이름을 넣는 편이 가장 명확합니다. 확인은 항상:

```sh
dsh --profile web --dump-config
```

`--dump-config`는 합성된 전체 entry 목록을 소스 파일별 주석과 함께 출력합니다.
`# == deepseek-my-plugin` 같은 주석이 번들 레이어의 경계입니다.

### 2.2 레이어 합성 순서

```text
빈 엔트리 리스트
  → bundle #1 patch
  → bundle #2 patch
  → ...
  → profile/cordis.patch.yml
  → $DSH_HOME/cordis.patch.yml      (profile 패치보다 우선)
  → --patch <file> 오버레이
```

- 뒤에 오는 레이어가 이깁니다.
- 패치는 **id로 row를 지목**합니다.
- `--dump-config`에는 `!!js` 표현식이 그대로 보입니다(평가 전).

### 2.3 patch YAML 문법

```yaml
# 1) 새 row 삽입
- insert:
    - id: deepseek-my-plugin
      name: deepseek-my-plugin

# 2) 기존 row의 config 전체 교체
#    (일부만 쓰면 나머지 필드는 사라집니다. 유지할 필드는 다시 적어야 합니다.)
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark

# 3) 비활성화
- id: some-row
  disabled: true

# 4) 부팅 시점 평가
- id: plugin-manager
  disabled: !!js '!ctx.get(''profileContext'')'
```

`name`에는 패키지 이름, 절대 경로, `file://` URL, patch 파일 기준 상대 경로
(`./`, `../`)를 쓸 수 있습니다. `insert` 안의 상대 경로는 **patch 파일 위치** 기준으로
file URL로 변환됩니다. 이미 존재하는 row를 대상으로 한 `name`은 리터럴로 취급됩니다.

빈 파일이나 주석만 있는 patch는 부팅을 실패시킵니다. 레이어를 끄려면 `[]`를 쓰십시오.

### 2.4 번들 레이어의 정체

번들은 "코드 + 그 코드를 마운트하는 설정 row"의 배포 형식입니다. 번들이 심은 row도
위 레이어에서 얼마든지 패치할 수 있습니다. 그래서 플러그인은 자기 기본값을 번들에
넣고, 사용자는 프로필 패치로 덮어씁니다.

---

## 3. 패키지 매니페스트 계약

플러그인 패키지의 `package.json` 한 장에 두 개의 매니페스트가 들어갑니다.

```jsonc
{
  "name": "deepseek-my-plugin",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web"
    }
  },
  "engines": { "dsh": ">=0.2.0 <0.3.0" }
}
```

| 필드 | 의미 | 비고 |
| --- | --- | --- |
| `main` | Host 절반 진입점 | ESM |
| `exports["./client"]` | Client 절반 번들 | **lazy-CJS factory** 형식 |
| `dsh.bundle.patch` | 번들이 제공하는 patch 파일 | 문자열 또는 순서 있는 배열 |
| `dsh.bundle.platforms` | Host OS 제한 (`["darwin"]` 등) | 생략 시 전체 허용 |
| `dsh.client.platform` | 클라이언트 플랫폼 | 현재 `"web"` |
| `dsh.client.inject` | 먼저 도착해야 하는 **패키지 row** 목록 | 서비스 inject와 다름 |
| `dsh.client.immediately` | 1단계 프리페치 여부 | 부트 초기에 필요한 커널급 플러그인 |
| `dsh.client.external` | 베이스라인에 없는 정확한 모듈 요청 | 남용 금지 |
| `engines.dsh` | 호환 런타임 범위 | 있으면 `peerDependencies`보다 우선 |

호환성 규칙:

- `engines.dsh`가 있으면 그 범위만으로 판정합니다.
- 없으면 `@deepseek-ai/dsh`, `@deepseek-ai/dsh-*` peer 범위를 모두 검사합니다.
- prerelease도 범위 매칭에 참여합니다. 그래서 `^0.2.2-rc.1` 같은 범위는
  `0.2.2-rc.1`을 만족하지 않습니다. **정확한 버전 고정**이 안전합니다.
- 선언이 아예 없으면 제약이 없습니다.

### 3.1 client 절반이 붙는 조건

두 가지가 동시에 필요합니다.

1. 패키지가 `dsh.client`를 선언하고 `exports["./client"]`를 제공한다.
2. Loader row의 `name`이 **하위 경로가 아닌 패키지 이름 그대로**다.

```yaml
- id: deepseek-my-plugin
  name: deepseek-my-plugin        # OK
# name: deepseek-my-plugin/tools  # client 절반은 붙지 않음
```

한 패키지를 여러 row로 쪼개는 번들은 client 절반을 **root row**에만 둡니다.
하위 row가 꺼져도 root row가 살아 있으면 페이지는 유지됩니다.

---

## 4. Host 부팅과 수명주기

### 4.1 Fiber 상태 기계

```text
PENDING → LOADING → ACTIVE
                 ↘ FAILED
ACTIVE → UNLOADING → DISPOSED
```

| 상태 | 의미 |
| --- | --- |
| `PENDING` | 선언됐지만 필요한 서비스가 아직 없음 |
| `LOADING` | 의존성이 준비되어 `apply` 실행 중 |
| `ACTIVE` | 실행 중 |
| `FAILED` | `apply`가 던짐 |
| `UNLOADING` | 정리 중 |
| `DISPOSED` | 완전히 내려감 |

`inject`에 선언한 서비스가 사라지면 플러그인은 자동으로 내려가고, 서비스가 돌아오면
다시 올라옵니다. 이것이 "로드 순서"를 수동으로 맞추지 않아도 되는 이유입니다.

### 4.2 `apply` 계약

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'
export const inject = ['tools']          // 선택: 필수 서비스
export interface Config { /* ... */ }    // 선택: 스키마와 같은 이름
export const Config = z.object({ /* ... */ })

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(/* ... */)
}
```

- `apply`가 반환한 Promise가 settle될 때까지가 초기화 구간입니다.
- 초기화 중 던진 예외는 fiber를 `FAILED`로 만듭니다.
- **`apply` 밖으로 새어 나간 비동기 작업의 unhandled rejection은 프로세스를 종료**시킵니다.
  장기 작업은 반드시 `ctx.effect`나 `ctx.jobs`로 소유하십시오.

### 4.3 정리(disposer) 규칙

```ts
ctx.on('tools/result', handler)      // 자동 해제
ctx.tools.register(tool)             // 자동 해제
ctx.effect(() => {
  const conn = connect()
  return () => conn.close()          // 언로드 시 실행
}, 'my-plugin: connection')
```

- 정리는 **등록 역순**으로 시작하지만, 여러 async disposer는 동시에 실행됩니다.
  순서가 중요한 정리는 `ctx.effect` 하나 안에서 직렬로 처리하십시오.
- `ctx.plugin(child)`로 만든 자식 fiber는 부모와 함께 재귀적으로 내려갑니다.

### 4.4 부팅 실패 정책

Web 프로필에서 `webserver`, `web-runtime`, `modules`, `connection` 등은 **required**입니다.
required row가 활성화되지 못하면 부팅 전체가 dispose되고 0이 아닌 코드로 종료됩니다.

| 상황 | optional row | required row | 이후 HMR |
| --- | --- | --- | --- |
| 모듈 import 실패 | 경고 후 계속 | 부팅 중단 | 형제 유지, 수정 시 재시도 |
| Config 스키마 위반 | 경고 후 계속 | 부팅 중단 | 기존 인스턴스 유지 |
| `apply` 동기 예외 | 경고 후 계속 | 부팅 중단 | 형제 유지 |
| `apply` 비동기 예외 | settle 후 경고 | settle 후 중단 | 형제 유지 |
| 주입 서비스 없음 | 대기 | 부팅 중단 | 제공자 추가 시 활성화 |
| apply 밖 unhandled rejection | **치명적** | **치명적** | **치명적** |

디버깅의 출발점은 항상 다음 두 가지입니다.

```sh
dsh --profile web --dump-config
```

그리고 브라우저의 Web boot audit(콘솔)과 서버 stderr의 라벨링된 진단입니다.

---

## 5. 서비스와 이벤트

### 5.1 서비스 제공

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    metrics: MetricsService
  }
}

export default class MetricsService extends Service {
  static inject = ['llm']          // 서비스도 다른 서비스에 의존할 수 있다

  constructor(ctx: Context) {
    super(ctx, 'metrics')
  }

  record(event: string, value: number): void { /* ... */ }
}
```

소비자는 `export const inject = ['metrics']`로 기다리거나, 선택 의존이면
`ctx.get('metrics')`로 조회합니다. 격리가 필요하면 `cordis.yml`의 `isolate`로
같은 키에 대해 그룹별 인스턴스를 만들 수 있습니다.

### 5.2 이벤트 4모드

| 모드 | 디스패치 | 리스너 계약 |
| --- | --- | --- |
| `emit` | 동기 브로드캐스트, 반환값 무시 | 아무것도 반환하지 않음 |
| `bail` | 순서대로, 첫 비-`null/false/undefined`가 결과 | 값을 반환하면 중단 |
| `serial` | 순서대로, async 대기 | 첫 비-`null/false/undefined`가 중단 |
| `waterfall` | 파이프라인 | **반드시 `next()` 호출** |

`waterfall`에서 `next()`를 빼면 파이프라인이 거기서 끊깁니다. 이는 버그가 아니라
의도된 게이트웨이 동작입니다.

타입은 declaration merging으로 붙입니다.

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'my-plugin/ready': (payload: { id: string }) => void
    'my-plugin/check': (input: string) => boolean | undefined
  }
}
```

### 5.3 durable event와 Cordis event를 구분하라

- `session/event`로 관찰하는 `turn/*`, `step/*`, `tool/call`, `tool/result`,
  `assistant/message`는 **세션 로그에 남는 durable record**입니다.
- `agent/*`, `tools/*`, `llm/*` 같은 이름은 **라이브 확장점(Cordis event)**입니다.
- "모델이 본 것은 반드시 로그에 있다"가 설계 원칙입니다. 모델 가시 입력을 추가하려면
  세션 이벤트를 추가해야 합니다.

---

## 6. Client 모듈 시스템

### 6.1 발견과 서빙

Host의 `@deepseek-ai/dsh-client-modules`(`ctx.clientModules`)가 활성 Loader row를 스캔해
`dsh.client` 선언을 찾고, 부트 그래프를 만들어 index에 주입합니다.

```text
package.json dsh.client  +  exports["./client"]
        │
        ▼
WebBootEntry { id(=패키지명), url, rev, inject?, immediately?, external? }
        │
        ▼
index 응답에 window.__DSH_BOOT__ 로 주입
        │
        ▼
GET /plugins/??deepseek-my-plugin/client.js&rev=<rev>
        │
        ▼
window.__ModuleLoader__.load({ id, factory }) 실행 (factory 등록만)
        │
        ▼
최초 사용 시 factory(require) → module.exports (memoize)
```

- script는 **factory를 등록만** 하고, 모듈 본문(CSS 주입 포함)은 materialize 시점에 돕니다.
- 그래서 아무도 쓰지 않는 플러그인의 코드는 실행되지 않습니다.
- `rev`는 `mtime + ctime + size`에서 나옵니다. 내용 해시가 아닙니다.
- `<id>/client`와 bare `<id>`는 같은 exports로 해석됩니다.

### 6.2 번들 형식

client 번들은 평범한 스크립트가 아니라 **factory 등록 스크립트**입니다.

```js
window.__ModuleLoader__.load({
  id: "deepseek-my-plugin",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    /* ... 번들 본문 ... */
    return module.exports
  }
})
```

이 형식은 `packages/client/tsdown.client.ts`의 `clientBundle` 프리셋이 만듭니다.
저장소 밖 패키지는 이 프리셋을 import할 수 없으므로 **tsdown 설정에서 직접 재현**해야
합니다. 이 저장소의 `tsdown.config.ts`가 그 예입니다.

주의할 점:

- `id`는 반드시 패키지 이름과 같아야 합니다.
- factory는 **CJS**입니다. `require` 사이클은 부분 exports를 전달할 수 없어 throw합니다.
- 번들 본문에서 Node 내장 모듈을 쓰면 브라우저에서 실패합니다.
- `require`는 아래 순서로 해석됩니다: 플랫폼 시드 테이블 → memoize된 레코드 →
  부트 그래프 row → 등록된 factory. 그 외는 throw.

### 6.3 공유 모듈 베이스라인

브라우저 셸은 다음을 **동결된 시드 테이블**로 제공합니다. client 번들은 이것들을
번들에 넣지 말고 external로 두어야 합니다.

```text
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis,
zod,
@tanstack/react-virtual,
@deepseek-ai/dsh-client-store,
@deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives,
@deepseek-ai/dsh-client-ui-dockkit
```

베이스라인 밖의 모듈이 필요하면 `dsh.client.external`에 정확한 specifier를 적고,
그 모듈을 제공하는 **동적 패키지 row**가 있어야 합니다. type-only import는 지워지므로
요청이 생기지 않습니다.

### 6.4 `inject`가 두 종류다

혼동하기 쉬운 지점입니다.

| 위치 | 의미 | 예 |
| --- | --- | --- |
| `package.json` `dsh.client.inject` | **모듈 그래프**에서 먼저 도착해야 하는 패키지 | `["@deepseek-ai/dsh-client-ui-settings"]` |
| client 모듈의 `export const inject` | **Cordis 서비스** 이름 | `["theme", "slots"]` |

전자는 "스크립트/팩토리 도착 순서", 후자는 "서비스 준비 대기"입니다. 둘 다 필요할 수
있고, 서로 대체하지 않습니다.

### 6.5 HMR과 release

- 열린 페이지는 Host의 그래프 변경을 따라갑니다. 플러그인을 끄면 row가 제거되고,
  그 플러그인의 effect가 정리된 뒤 사용되지 않는 모듈/스타일이 evict됩니다.
- 페이지가 부팅한 Host release와 다른 release의 그래프는 적용되지 않습니다.
  이때는 페이지 새로고침이 필요합니다.
- 개발 중 client 번들을 다시 빌드하면 `rebuilt()` 경로로 그래프에 반영됩니다.
  entry restart 없이도 rev가 바뀌면 새 번들이 로드됩니다.

### 6.6 자산(assets)

`"./assets/*": "./lib/assets/*"` export를 선언하면 `/plugins/<pkg>/assets/<path>`로
서빙됩니다. 빌드 프리셋은 파일 이름에 내용 리비전(SHA-1 앞 12자리)을 넣고
`require.asset(...)` 호출로 바꿉니다. 저장소 밖에서 같은 기능을 쓰려면 이 형식을
직접 맞춰야 합니다. 이미지 몇 장이면 `require.asset` 없이 플러그인 코드에서
URL을 문자열로 두는 편이 단순합니다.

---

## 7. Web UI 조합 계층

브라우저 쪽도 Cordis 앱입니다. 모듈 로더가 플러그인을 materialize하고, 각 플러그인의
`apply`가 슬롯·테마·설정·커맨드 같은 서비스를 사용합니다.

### 7.1 Slots

Slot은 Web Client의 **타입이 있는 React 합성 시스템**입니다. 기능 플러그인은 다른
플러그인의 컴포넌트를 import하지 않고, 슬롯에 자기 컴포넌트를 등록합니다.

두 축이 있습니다.

| 축 | 값 | 의미 |
| --- | --- | --- |
| cardinality | `single` | 한 칸. 우선순위 승자가 렌더 |
| | `list` | 필수 `id`로 주소화, `order` 순 |
| | `keyed` | owner가 `entryKey`로 디스패치 |
| | `chain` | `select(owner)`가 첫 비-null을 고름 |
| | `hoc` | owner 콘텐츠를 감싸는 레이어 |
| scope | `root` | 루트 스코프 |
| | `session-maybe` | 세션 바인딩이 없어도 렌더 |
| | `session` | 세션 바인딩 필수 |

기여 방법은 두 가지입니다.

```tsx
// 1) 이미 선언된 슬롯에 등록 (가장 흔함)
export const inject = ['slots']

ctx.slots.inject('conversation.session.header.actions', () =>
  ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'review',
    order: 100,
  }, HeaderAction))

// 2) 자식 슬롯을 소유하는 부모로 등록
ctx.slots.register({
  name: 'settings.section',
  id: 'my-section',
  order: 40,
  label: () => t('nav'),
  children: { 'my-plugin.panel': { kind: 'list', scope: 'root' } },
}, MySection)
```

`children` 선언은 그 슬롯 키를 활성화하고, 부모가 `renderSlot`/`renderSlotChain`으로
렌더할 권한을 줍니다. 선언되지 않은 슬롯에 등록하면 **플러그인 활성화가 실패**합니다.

새 슬롯 키를 만들려면 `SlotMap`을 declaration merging합니다.

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'my-plugin.panel': { kind: 'list'; scope: 'root'; owner: MyOwnerProps }
  }
}
```

컴포넌트는 `ctx`를 받지 않습니다. 서비스와 모델 객체는 `apply` 클로저에 두고,
콜백이나 observable 소스로 투영합니다. 공유 뷰 상태는 `store`, 비공개 데이터는
`inject` 팩토리로 전달합니다.

### 7.2 테마와 디자인 토큰

테마 서비스(`ctx.theme`)는 `--dsw-*` 토큰의 레지스트리입니다. `light`/`dark`가
내장이고, 서드파티는 **override 레이어**를 쌓습니다.

```ts
ctx.effect(() => ctx.theme.overrideTokens('my-plugin', {
  '--dsw-alias-bg-base': { light: 'chocolate', dark: 'chocolate' },
}), 'my-plugin: theme')
```

- 레이어는 `source`당 하나입니다. 같은 source로 다시 호출하면 그 레이어를 교체합니다.
- 값은 반드시 `{ light, dark }` 쌍입니다. 문자열을 바로 넣으면 **런타임에 throw**합니다.
- 활성 팔레트에 맞는 값이 선택되어 스냅샷에 접혀 들어갑니다. 사용자의 light/dark
  선택 자체는 건드리지 않습니다.
- disposer가 실행되면 덮였던 값이 그대로 복원됩니다.

토큰 검사 목록(내장):

| 토큰 | 역할 |
| --- | --- |
| `--dsw-alias-bg-base` | 앱 기본 배경 |
| `--dsw-alias-bg-layer-1` | 1차 표면 |
| `--dsw-alias-bg-layer-2` | 2차 중첩 표면 |
| `--dsw-alias-bg-overlay` | 오버레이/팝오버 |
| `--dsw-alias-border-l1` / `-l2` | 테두리 |
| `--dsw-alias-brand-primary` | 브랜드 강조 |
| `--dsw-alias-label-primary` / `-secondary` | 텍스트 |
| `--dsw-alias-state-{error,idle,success,warn}-primary` | 상태색 |
| `--dsw-specific-sidebar-fill` | 사이드바 배경 |

전체 팔레트를 갈아끼우려면 `ctx.theme.register(definition)`을 씁니다. 토큰 몇 개만
바꾸려면 `overrideTokens`가 맞습니다. 이 플러그인은 후자를 씁니다.

### 7.3 설정(Config)과 UI

Host 쪽에서 **volatile** 필드로 선언한 값만 폼으로 투영됩니다.

```ts
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  retries: Volatile<number>
}

export const Config = z.object({
  retries: z.number().min(0).default(3).volatile(),
})

export function apply(ctx: Context, config: Config) {
  ctx.on('loader/volatile-update', () => {
    ctx.logger.info('retries=%d', config.retries.get())
  })
}
```

- 값은 작업 시작 시점에 `.get()`으로 읽습니다. 일관된 스냅샷이 필요하면 한 번만 캡처합니다.
- 교차 필드 검증은 `.check()`에 둡니다. Host에서 저장 전에 실행됩니다.
- 폼 namespace는 **profile entry id**입니다. 같은 플러그인을 여러 row로 띄우면 폼도
  따로입니다.
- 자체 설정 페이지를 붙이는 플러그인은 `ctx.inject(['settings'], child => ...)` 안에서
  `child.settings.configure({ auto: false }, ctx.fiber)`를 effect로 등록합니다.
- Client는 `ctx.configForms.get<T>(entryId)`로 같은 값을 구독·편집합니다.

```ts
const form = ctx.configForms.get<ThemeSettings>('ui-theme')
form.subscribe(() => { /* form.getSnapshot().value */ })
await form.set('preference', 'dark')
```

설정 UI를 붙이는 지점:

| 슬롯 | 용도 |
| --- | --- |
| `settings.section` | Settings 좌측 내비게이션의 한 섹션 |
| `settings.general.item` | General 섹션의 한 행 |
| `settings.plugins.tab` | Plugins 섹션 안의 탭 |
| `plugins.detail.section` | 플러그인 상세 페이지의 섹션 |
| `plugins.detail.actions` / `.badge` | 상세 페이지 헤더 컨트롤/배지 |

### 7.4 다국어와 단축키

```ts
const NS = 'my-plugin'
const t = ctx.locale.bind(NS)

ctx.effect(() => ctx.locale.register(NS, { en, ko }), 'my-plugin: locales')
```

- 사전은 `Record<string, ...>` 트리이고, `bind(ns)`가 `t` 함수를 만듭니다.
- 슬롯 등록의 `locale: NS` 옵션은 컴포넌트에 `t` prop을 주입합니다.
- 키보드 단축키는 `ctx.shortcuts.register(command)`입니다. 커맨드 id, 기본 바인딩,
  대상 resolver를 선언하고 disposer로 해제합니다. 데스크톱/웹 런타임 차이는
  `ctx.shortcuts.runtime`으로 판별합니다.

---

## 8. 데이터가 사는 곳

| 데이터 | 위치 | 소유자 |
| --- | --- | --- |
| 프로필 구성 | `$DSH_HOME/profiles/<name>/package.json` | launcher / plugin manager |
| 사용자 패치 | `$DSH_HOME/profiles/<name>/cordis.patch.yml` | 사용자 |
| 홈 패치 | `$DSH_HOME/cordis.patch.yml` | 사용자 (최우선) |
| 설치된 패키지 | `profiles/<name>/node_modules` | pnpm |
| 플러그인 소스/빌드 | 이 저장소 | 우리 |
| 세션 로그 | 세션 저장소 (`session/event`) | `ctx.sessions` |
| 라이브 UI 상태 | 브라우저 메모리 | client plugin |
| 테마 override | 브라우저 메모리 (레이어) | `ctx.theme` |
| 설정 값 | profile patch (volatile 필드) | 설정 서비스 |

원칙: **모델이 본 것은 로그에 남는다.** 재시작 후에도 의미가 있어야 하는 상태는
세션 이벤트로, 일시적 UI 상태는 브라우저에 둡니다.

---

## 9. 확장 지점 지도

복잡한 플러그인을 만들 때 "무엇을 어디에 붙이는가"의 지도입니다.

| 하고 싶은 것 | 메커니즘 | 진입 API |
| --- | --- | --- |
| 모델 도구 추가 | tool registry | `ctx.tools.register(defineTool(...))` |
| 도구 호출 정책 | waterfall / guard | `tools/pre-execute`, `ctx.tools.guard()` |
| 도구 결과 가공/관측 | waterfall / emit | `tools/post-execute`, `tools/result` |
| 사람용 슬래시 커맨드 | command registry | `ctx.commands.register(...)` |
| 새 서비스 제공 | Cordis service | `class X extends Service`, `super(ctx, 'key')` |
| 요청/턴 가로채기 | agent events | `agent/pre-step`, `agent/turn-stopping` |
| HTTP 엔드포인트 | web server | `ctx.webServer.register({ kind, path, handler })` |
| HTML 주입 | index injection | `webserver/index-inject` 리스너 |
| 백그라운드 작업 | jobs | `ctx.jobs.start({ kind, label, owner, run })` |
| 설정 폼 | volatile Config | `z.*.volatile()` + `ctx.settings.configure` |
| UI 섹션/행 | slots | `ctx.slots.inject` + `ctx.slots.register` |
| 테마 | tokens | `ctx.theme.overrideTokens` / `register` |
| 다국어 | locale | `ctx.locale.register` / `bind` |
| 단축키 | shortcuts | `ctx.shortcuts.register` |
| Host↔Client RPC | typert Remote | `TypertRemoteService` + `@Remote` |
| 세션에 남는 새 사실 | session event | `SessionEventMap` 확장 |
| Web 채팅 노드 | conversation | `ConversationNodeDefinition` + keyed renderer |
| 도구 결과 카드 | tool view slot | `tool.call.toolview` |

Host 쪽에서 클라이언트로 값을 내려보내는 가장 단순한 방법은 **index injection**입니다.
`webserver/index-inject` 테이블에 행을 추가하면 index HTML에 구조화된 행이 들어갑니다.
테마의 부트 팔레트가 이 방식을 씁니다.

---

## 10. 패키지 레이아웃과 빌드 그래프

```text
deepseek-my-plugin/
├── package.json          # 두 매니페스트 + 스크립트
├── cordis.patch.yml      # 번들이 심는 Loader row
├── tsconfig.json
├── tsdown.config.ts      # host ESM + client factory
├── src/
│   ├── index.ts          # Host 절반
│   └── client/index.ts   # Client 절반
├── lib/                  # 커밋되는 빌드 산출물
│   ├── index.js
│   ├── client.js
│   └── client.js.map
├── docs/
│   ├── ARCHITECTURE.md
│   ├── IMPLEMENTATION-GUIDE.md
│   └── screenshots/
├── README.md
└── TUTORIAL.md
```

빌드 그래프:

```text
src/index.ts ──(tsdown, format=esm, platform=node)──→ lib/index.js
src/client/index.ts
   └─(tsdown, format=cjs, platform=browser, banner/footer)──→ lib/client.js
                                                               └─→ lib/client.js.map
```

의존성 원칙:

- 하네스 패키지는 **devDependency + type-only import**로만 가져옵니다.
  런타임 객체는 Host나 브라우저가 제공합니다.
- client 코드에서 다른 플러그인의 값을 import하지 않습니다. 타입만
  `import type {} from '...'`로 가져와 `ctx` 병합을 얻습니다.
- `lib/`을 커밋하면 설치자가 빌드할 필요가 없습니다.

---

## 11. 깨뜨리면 바로 아픈 불변식

1. Loader row의 `name`은 **bare 패키지 이름**이어야 client 절반이 붙는다.
2. client 번들의 `id`는 패키지 이름과 같아야 한다.
3. client 번들은 **factory 등록 스크립트**여야 한다. 일반 IIFE 번들은 등록되지 않는다.
4. `dsh.client.inject`(모듈 도착)와 `export const inject`(서비스)를 혼동하지 않는다.
5. 공유 모듈은 번들에 넣지 말고 베이스라인/external로 둔다.
6. `overrideTokens` 값은 `{ light, dark }` 쌍이어야 한다.
7. 모든 등록은 `ctx.effect`/disposer로 정리되어야 한다. 새는 리스너는 HMR에서 중복된다.
8. `apply` 밖의 비동기 작업을 소유하지 않으면 프로세스가 죽는다.
9. 모델 가시 입력은 세션 이벤트로 남겨야 재생·포크·텔레메트리가 맞는다.
10. 설정을 영속화하려면 volatile 필드여야 한다. 일반 필드는 폼에 나오지 않는다.

---

## 12. 더 읽을 소스

| 주제 | 경로 |
| --- | --- |
| 전체 아키텍처 | `docs/architecture.md` |
| Cordis 입문 | `docs/cordis-primer.md` |
| Profile/bundle 합성 | `packages/boot/app-boot/README.md` |
| 클라이언트 모듈 | `docs/subsystems/client-modules.md`, `packages/client/modules/README.md` |
| Web Client 구조 | `docs/subsystems/web-client.md` |
| 슬롯 레퍼런스 | `docs/subsystems/slots.md` |
| 도구 파이프라인 | `docs/subsystems/tools.md`, `packages/core/tools/src/index.ts` |
| 설정 폼 | `docs/subsystems/settings.md`, `packages/settings/settings/README.md` |
| Remote API | `docs/cookbook/adding-a-remote-api.md`, `docs/api-gateway.md` |
| 실제 테마 플러그인 | `packages/client/ui-theme/src/{index.ts,client/index.ts}` |
| 실제 설정 UI | `packages/client/ui-settings-plugins/src/client/index.ts` |
| client 번들 프리셋 | `packages/client/tsdown.client.ts` |
| 공유 모듈 베이스라인 | `packages/client/web/src/platform.ts` |
| 부트 그래프 타입 | `packages/client/modules/src/client/manifest.ts` |

버전이 바뀌면 위 파일들의 실제 시그니처를 먼저 확인하십시오. 이 문서는 구조를
이해하기 위한 지도이고, 최종 계약은 항상 소스와 생성된 `cordis-surface`가 소유합니다.
