# Cordis 구조와 사용법

이 문서는 DeepSeek Harness 아래에 깔린 플러그인 프레임워크 **Cordis**만 따로 떼어 설명합니다.
"Context가 뭔지", "fiber가 왜 필요한지", "effect가 왜 모든 것의 단위인지", "서비스와 이벤트를
언제 쓰는지"를 구조와 사용법 양쪽에서 정리합니다.

- 대상 버전: Cordis `4.1.0` (하네스는 `@deepseek-ai/cordis`로 vendoring)
- 예제 패키지: `deepseek-my-plugin/`
- 기준 문서: 하네스의 `docs/cordis-primer.md`, `docs/cordis-api/*`, `docs/cordis-tutorial/*`

관련 문서:

- [PLUGIN_MODEL.md](./PLUGIN_MODEL.md) — 에이전트 코어와 플러그인이 통신하는 방식
- [ARCHITECTURE.md](./ARCHITECTURE.md) — dsh 런타임의 profile/bundle/모듈 로더 구조
- [IMPLEMENTATION-GUIDE.md](./IMPLEMENTATION-GUIDE.md) — 실제 플러그인 작성 레시피

> Cordis를 "dsh가 쓰는 DI 라이브러리" 정도로 알고 있다면 2~5절만 읽어도 충분합니다.
> 6~8절은 서비스·이벤트·조합, 9~10절은 설정과 dsh 관례, 11~13절은 진단과 치트시트입니다.

---

## 0. 한 문장 요약

> **Cordis는 Context라는 프록시 하나에 서비스·이벤트·수명(effect)을 묶고, 플러그인을 그
> Context에 마운트하는 작은 런타임이다.**

```text
+----------------------------- Cordis runtime ------------------------------+
|                                                                           |
|   Context  ──── service store (ctx.tools, ctx.llm, ...)                   |
|      │      ──── event bus    (ctx.on / emit / waterfall / ...)           |
|      │      ──── registry     (ctx.plugin / inject)                       |
|      │      ──── logger / reflect                                         |
|      │                                                                    |
|      └── Fiber ── plugin instance (state + config + effects)              |
|             └── Effect ── reversible registration (disposer)              |
|                                                                           |
+---------------------------------------------------------------------------+
```

Cordis에는 "특권을 가진 코어"가 없습니다. 모델 어댑터, 툴 레지스트리, 세션 로그, 에이전트
루프까지 전부 플러그인이고, 설정으로 교체할 수 있습니다. 이 성질이 dsh의 확장 모델 전체를
떠받칩니다.

---

## 1. 다섯 가지 아이디어

| 아이디어 | 의미 | 이 문서 |
| --- | --- | --- |
| **Plugin** | `apply(ctx, config)`를 가진 함수/클래스/객체 | 3절 |
| **Context** | 서비스 저장소이자 이벤트 버스인 프록시 | 2절 |
| **Inject** | "이 서비스가 생길 때까지 기다려라"는 선언 | 6절 |
| **Event** | 이름으로 하는 느슨한 통신, 5가지 디스패치 모드 | 7절 |
| **Effect** | 등록과 해제가 한 쌍인 되돌릴 수 있는 작업 | 5절 |

이 다섯 개가 전부입니다. 나머지(`isolate`, `intercept`, `group`, loader, HMR)는 이 위에
얹힌 조합입니다.

---

## 2. Context — 서비스 저장소이자 프록시

### 2.1 프록시라는 사실

`ctx`는 평범한 객체가 아니라 **Proxy**입니다.

- `ctx.tools` 같은 프로퍼티 읽기는 서비스 해석기(service resolver)를 거칩니다.
- `ctx.on`, `ctx.emit` 같은 이벤트 메서드는 `ctx.events` 서비스에서 mixin된 것입니다.
- `ctx.plugin`, `ctx.inject`는 `ctx.registry`에서 mixin된 것입니다.
- `ctx.extend`, `ctx.isolate`, `ctx.intercept`는 **부모를 바꾸지 않고** 자식 Context를
  만듭니다.

```text
root Context
   │
   ├─ fiber A 의 ctx        (A 플러그인이 보는 세계)
   │     ├─ extend(meta)      → 메타데이터만 덧씌운 자식
   │     ├─ isolate('shell')  → shell 서비스만 다른 스코프인 자식
   │     ├─ intercept('llm')  → llm 설정만 덧씌운 자식
   │     └─ plugin(child)     → 자식 fiber + 자식 ctx
   │
   └─ fiber B 의 ctx
```

중요한 성질: **자식 Context는 부모의 서비스를 그대로 봅니다.** 격리는 `isolate`를 쓴
경우에만, 그리고 **지정한 서비스 이름에만** 일어납니다.

### 2.2 서비스 저장소 API

| API | 역할 | 주의 |
| --- | --- | --- |
| `ctx.get(name, strict?)` | 주입 없이 조회 | 기본 `strict=true`는 **활성 제공자만** 반환 |
| `ctx.provide(name, value)` | 서비스 등록 | 이미 있으면 throw, disposer 반환 |
| `ctx.set(name, value)` | 제공된 값 교체 | **제공한 fiber만** 가능 |
| `ctx.accessor(name, { get, set? })` | 계산된 프로퍼티 | unload 시 제거 |
| `ctx.mixin(name, keys)` | 서비스 멤버를 `ctx`에 노출 | `ctx.on`이 `ctx.events.on`인 이유 |
| `ctx.root` | 루트 Context | 앱 전역 접근이 필요할 때만 |

`ctx.get`과 `inject`의 차이는 **기다리느냐**입니다.

```ts
// 선택 의존: 없으면 undefined, 플러그인은 계속 실행
const metrics = ctx.get('metrics')
metrics?.record('boot', 1)

// 필수 의존: 없으면 fiber가 PENDING
export const inject = ['metrics']
```

### 2.3 Context를 합성하는 네 가지 방법

| 방법 | 만드는 것 | 영향 범위 |
| --- | --- | --- |
| `ctx.extend(meta)` | 메타데이터가 얹힌 자식 | 이 Context 아래 |
| `ctx.isolate(name, label?: symbol)` | 서비스 스코프가 분리된 자식 | 이 Context 아래, 해당 이름만 |
| `ctx.intercept(name, config)` | 서비스 설정이 병합된 자식 | 이 Context 아래 |
| `ctx.plugin(plugin)` | 새 fiber + 새 ctx | 자식 fiber의 수명 |

```text
                 root ctx
                    │
        ┌───────────┴────────────┐
        │                        │
   ctx.isolate('shell')     ctx.isolate('shell')
   (label: sym-1)           (label: sym-2)
        │                        │
   shell = local-bash       shell = remote-ssh
```

같은 `label`을 두 번 넘기면 두 스코프가 **합쳐집니다**. 이것이 "그룹 단위로 같은 인스턴스를
공유"하는 방법입니다. 코드 레벨에서 `label`은 `symbol`이고, YAML에서는 문자열 라벨을 주면
Loader가 그룹별 심볼로 매핑합니다(`isolate: { shell: 'shared' }`).

---

## 3. Plugin — 세 가지 형태

### 3.1 형태

```ts
// 1) 함수 플러그인
export const name = 'my-plugin'
export function apply(ctx: Context, config: Config) { /* ... */ }

// 2) 객체 플러그인
export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context) { /* ... */ },
}

// 3) 클래스 플러그인 (Service가 대표적)
export class MyService extends Service {
  constructor(ctx: Context) { super(ctx, 'myService') }
}
```

함수 형태는 `apply`라는 이름이 없어도 됩니다. Cordis가 함수 자체를 호출합니다. 객체
형태는 `apply`가 **필수**입니다. 클래스 형태는 생성자가 곧 초기화입니다.

### 3.2 선언 필드

| 필드 | 타입 | 의미 |
| --- | --- | --- |
| `name` | `string` | fiber/로그 진단에 쓰는 표시 이름 |
| `inject` | `string[] \| Record<string, config>` | 필수 서비스. 충족 전까지 PENDING |
| `Config` | Standard Schema | config 검증기. 실패 시 FAILED |
| `provide` | `string \| string[]` | 이 플러그인이 제공하는 서비스 이름(선언 메타데이터) |
| `intercept` | `Record<string, boolean>` | 소비하는 intercept 설정 선언 |

`provide`는 **선언일 뿐 자동 등록이 아닙니다.** 실제 등록은 `ctx.provide()`나 `Service`
생성자가 합니다. `provide` 필드는 `Service`가 기본 이름을 얻을 때와 로더/도구가 카탈로그를
만들 때 읽힙니다.

```ts
export const name = 'my-plugin'
export const inject = ['tools', 'llm']
export const Config = z.object({ /* ... */ })
export const provide = ['myCapability']
```

`inject`의 객체 형태는 서비스별 intercept 설정을 함께 넘깁니다.

```ts
export const inject = {
  tools: {},
  llm: { /* 이 플러그인 문맥에서만 병합될 설정 */ },
}
```

### 3.3 `apply` 계약

```ts
export function apply(ctx: Context, config: Config) {
  ctx.tools.register(myTool)     // effect
  return () => { /* 추가 정리 */ } // 반환값도 effect로 취급된다
}
```

- `apply`는 동기/비동기 모두 가능합니다.
- 반환한 Promise가 settle될 때까지가 **초기화 구간**입니다.
- 반환값은 effect로 수집됩니다. disposer를 반환해도 되고, Promise/이터레이터도 됩니다.
- `apply` 안에서 던진 예외는 fiber를 `FAILED`로 만듭니다.
- **`apply` 밖으로 새어 나간 비동기 작업의 unhandled rejection은 프로세스를 종료**시킵니다.
  dsh의 `app-boot`가 `unhandledRejection`/`uncaughtException`을 fatal로 보고 `process.exit(1)`을
  호출하기 때문입니다.

마지막 항목이 가장 흔한 사고입니다. 타이머, 소켓, 큐 펌프는 반드시 effect로 소유하십시오.

---

## 4. Fiber — 플러그인 인스턴스의 수명

플러그인을 `ctx.plugin()` 하거나 Loader가 row를 마운트하면 **fiber**가 하나 생깁니다.
fiber는 그 인스턴스의 상태·설정·effect·정리 의무를 소유합니다.

### 4.1 상태 기계

```text
PENDING ──(필수 서비스 등장)──► LOADING ──(apply 정상)──► ACTIVE
   ▲                              │                        │
   │                              │ (throw)                │ (owner dispose)
   │                              ▼                        ▼
   │                           FAILED                  UNLOADING
   │                                                       │
   │                                                       ├─► DISPOSED
   │                                                       │   (disposer settle)
   └────────────(서비스 복귀, 아직 마운트됨)────────────────┘
                   UNLOADING → PENDING
```

`apply`가 던지면 `LOADING → FAILED`로 갑니다. `FAILED` fiber는 스스로 재시도하지 않고,
입력(config/의존성)이 고쳐진 뒤 명시적 update가 있어야 다시 시도합니다.

### 4.2 전이 조건

| 전이 | 조건 |
| --- | --- |
| `PENDING → LOADING` | `inject`의 모든 서비스가 활성화됨 |
| `LOADING → ACTIVE` | `apply`가 정상 반환(또는 Promise settle) |
| `LOADING → FAILED` | `apply` 또는 config 해석이 던짐 |
| `ACTIVE → UNLOADING` | 소유자 dispose, 설정 변경, 서비스 소실, HMR |
| `UNLOADING → DISPOSED` | 소유자가 내려갔고 모든 disposer가 settle |
| `UNLOADING → PENDING` | 의존 서비스만 사라졌고 fiber는 계속 마운트됨 |

### 4.3 트리와 소유권

```text
root fiber (uid 0)
   │
   ├─ loader fiber
   │     └─ entry A fiber
   │           ├─ child fiber  (ctx.plugin)
   │           └─ child fiber
   │
   └─ entry B fiber
         └─ child fiber
```

- 부모를 dispose하면 자식도 **재귀적으로** 내려갑니다.
- `ctx.plugin(child)`가 돌려주는 fiber를 보관하면 자식만 따로 내릴 수 있습니다.
- 서비스 제공자 fiber가 내려가면, 그 서비스를 `inject`한 소비자도 함께 내려갑니다.

### 4.4 fiber API

| 멤버 | 의미 |
| --- | --- |
| `fiber.state` | 현재 `FiberState` |
| `fiber.ctx` | 이 fiber의 플러그인이 실행되는 Context |
| `fiber.config` | 다음 활성화를 위해 보관된 raw config |
| `fiber.name` | 가장 가까운 이름 있는 조상에서 상속된 표시 이름 |
| `fiber.uid` | 레지스트리 내 고유 id, dispose 후 `null` |
| `fiber.dispose()` | 플러그인 unload 후 정리 완료까지 대기 |
| `fiber.inertia` | 진행 중인 load/unload 전이 Promise |
| `fiber.getEffects()` | effect 라벨 트리(진단용) |

### 4.5 PENDING은 정상 상태다

`inject`한 서비스가 아직 없으면 fiber는 **아무 로그도 없이** PENDING에 머뭅니다. 이것은
오류가 아니라 "제공자가 나중에 올 수 있다"는 정상 대기입니다. 다만 PENDING fiber는 Node의
이벤트 루프를 붙잡지 않으므로, 조합에 다른 작업이 없으면 프로세스가 조용히 종료될 수
있습니다.

진단은 11절에서 다룹니다.

---

## 5. Effect — 모든 등록은 되돌릴 수 있어야 한다

### 5.1 effect가 받는 네 가지 형태

```ts
ctx.effect(() => () => cleanup())                  // 1) disposer
ctx.effect(async () => {                            // 2) Promise<disposer>
  const conn = await connect()
  return () => conn.close()
})
ctx.effect(function* () {                           // 3) 동기 이터레이터
  yield () => cleanupA()
  yield () => cleanupB()
})
ctx.effect(async function* () {                     // 4) 비동기 이터레이터
  yield () => cleanupA()
  yield () => cleanupB()
})
```

이터레이터 형태는 **생산되는 즉시** 각 disposer를 등록합니다. 중간에 실패해도 이미 만든
정리는 보장됩니다. 순서가 중요한 정리는 이 형태로 한 effect 안에 묶으십시오.

### 5.2 정리 순서

```text
apply 실행
  ├─ ctx.on(...)              → effect A (#1)
  ├─ ctx.tools.register(...)  → effect B (#2)
  └─ ctx.effect(...)          → effect C (#3)
        ├─ yield disposer c1
        └─ yield disposer c2

unload
  effect A ─┐
  effect B ─┼─ Promise.all: 역순으로 시작, 완료는 동시(순서 보장 없음)
  effect C ─┘   └─ c2 → (await) → c1   (한 effect 안에서는 역순 + 직렬)
```

두 층위를 구분해야 합니다.

- **effect 사이**: fiber unload는 `this._disposables.clear()`가 돌려준 **역순 목록**을
  `Promise.all`로 실행합니다. 호출은 역순으로 시작하지만, 서로의 완료를 기다리지 않습니다.
- **한 effect 안**: 그 effect가 수집한 disposer들은 **등록 역순**으로, 그리고 **직렬**로
  실행됩니다(앞의 disposer가 settle된 뒤 다음이 시작).

따라서 "A 다음에 B가 정리되어야 한다"는 요구가 있으면 두 작업을 **같은 effect 안**에 넣고
이터레이터로 yield하거나, 하나의 disposer 안에서 `await`로 이어 붙이십시오. `ctx.on`이나
`ctx.tools.register`는 각각 별개의 top-level effect이므로 서로의 정리 순서를 기대할 수
없습니다.

- 같은 disposer를 두 번 호출해도 no-op입니다.
- top-level effect 하나가 던져도 다른 effect의 정리는 계속됩니다(각각 try/catch). 반면 한
  effect 안의 직렬 체인에서 앞 disposer가 reject하면 그 effect의 남은 disposer는 실행되지
  않습니다.

### 5.3 이미 effect인 것들

직접 `ctx.effect`를 쓸 일은 많지 않습니다. 다음은 전부 자동으로 effect가 됩니다.

| 등록 | 정리 |
| --- | --- |
| `ctx.on(event, fn)` | 리스너 제거 |
| `ctx.once(event, fn)` | 첫 호출 후 자기 제거 |
| `ctx.plugin(child)` | 자식 fiber dispose |
| `ctx.provide(name, value)` | 서비스 등록 해제 |
| `ctx.accessor`, `ctx.mixin` | 프로퍼티 제거 |
| `ctx.tools.register(tool)` | 툴 등록 해제 |
| `ctx.slots.register(slot)` | UI 슬롯 해제 |

### 5.4 라벨과 진단

```ts
ctx.effect(() => {
  const timer = setInterval(poll, 1000)
  return () => clearInterval(timer)
}, 'my-plugin: poll timer')

console.log(fiber.getEffects())
// [{ label: 'my-plugin: poll timer', children: [] }, ...]
```

라벨은 `getEffects()`와 `internal/plugin` 진단에서 그대로 보입니다. "이 fiber가 어떤 자원을
쥐고 있는가"를 확인할 때 유용합니다.

### 5.5 effect 안의 effect

effect 실행 중에 만들어진 등록은 그 effect의 **자식**으로 기록됩니다.

```ts
ctx.effect(() => {
  const conn = connect()
  const off = ctx.on('some/event', handler)   // 이 effect의 자식
  return () => {
    off()
    conn.close()
  }
})
```

이 구조 덕분에 라벨 트리로 소유 관계를 추적할 수 있습니다.

### 5.6 금지: UNLOADING 중 등록

fiber가 `UNLOADING`일 때 `ctx.effect`는 `INACTIVE_EFFECT`로 거부됩니다. 정리 중에 새 등록을
만들면 unload 스냅샷을 벗어나 누수되기 때문입니다. 등록은 `PENDING`·`LOADING`·`ACTIVE`
어디서든 가능하고, `UNLOADING`에서만 막힙니다.

---

## 6. Service — 이름으로 능력 공유

### 6.1 제공과 소비

```ts
// 제공자
export function apply(ctx: Context) {
  ctx.provide('myCapability', {
    doWork() { /* ... */ },
  })
}

// 소비자
export const inject = ['myCapability']
export function apply(ctx: Context) {
  ctx.myCapability.doWork()
}
```

`provide`가 돌려주는 disposer는 fiber unload 시 자동 실행됩니다. `provide`는 같은 격리
스코프에 이미 같은 이름이 있으면 던집니다.

### 6.2 `Service` 클래스

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    metrics: MetricsService
  }
}

export class MetricsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'metrics')
  }

  record(event: string, value: number) { /* ... */ }
}

export const name = 'metrics'
export function apply(ctx: Context) {
  ctx.plugin(MetricsService)
}
```

- `super(ctx, name)`이 **즉시** 서비스를 등록합니다.
- 등록은 소유 fiber의 effect이므로 unload와 함께 사라집니다.
- `declare module`은 타입만 추가합니다. 런타임 배선은 없습니다.
- `Service` 서브클래스 자체가 플러그인이므로 `ctx.plugin(ServiceClass)`로 마운트합니다.

`Service`에는 몇 가지 심볼 훅이 있습니다.

| 심볼 | 용도 |
| --- | --- |
| `Service.init` | 생성 직후 실행할 인스턴스 메서드 |
| `Service.check` | `provide`의 가용성 술어 |
| `Service.config` | intercept 설정 타입을 담는 phantom 필드 |
| `Service.invoke` | 서비스를 호출 가능하게 만드는 본문 (`ctx.logger(...)`처럼) |
| `Service.extend` | 확장 인스턴스를 파생하는 헬퍼 |
| `Service.tracker` | 컨텍스트 추적(trace) 메타데이터 |
| `Service.resolveConfig` | intercept 설정 해석 헬퍼 (조상 → 가까운 순으로 병합) |

### 6.3 의존성 추적은 일회성이 아니다

`inject`는 부팅 시 한 번만 확인하는 것이 아닙니다.

```text
provider ACTIVE ──► consumer ACTIVE
provider UNLOADING ──► consumer UNLOADING (자동)
provider ACTIVE (재등록) ──► consumer LOADING → ACTIVE (자동)
```

그래서 소비자는 "사라진 서비스의 참조"를 들고 있을 수 없습니다. 제공자를 교체하면 소비자도
새 구현으로 재시작됩니다. dsh에서 `ctx.tools` 제공자를 바꿔도 툴 소비자가 그대로 동작하는
이유입니다.

### 6.4 선택 의존

```ts
export function apply(ctx: Context) {
  const approval = ctx.get('approval')
  if (approval) { /* 있을 때만 */ }
}
```

`ctx.get`은 기본적으로 **활성 제공자만** 반환합니다. `ctx.get(name, false)`는 비활성
구현도 반환하므로, 수명이 끝난 서비스를 붙잡고 싶을 때만 쓰십시오(대개는 버그입니다).

### 6.5 `isolate`로 인스턴스 분리

```yaml
- id: group-a
  name: '@deepseek-ai/cordis-plugin-group'
  group: true
  isolate:
    shell: true
  config:
    - name: '@deepseek-ai/dsh-bash-local'
      config: { timeoutMs: 5000 }
    - name: './src/plugin-a.ts'

- id: group-b
  name: '@deepseek-ai/cordis-plugin-group'
  group: true
  isolate:
    shell: true
  config:
    - name: '@deepseek-ai/dsh-bash-sandbox'
```

```text
root: shell = (없음)
 ├─ group-a: shell = bash-local(timeout 5s)
 └─ group-b: shell = bash-sandbox
```

`isolate: { shell: true }`는 그 그룹 전용 라벨을 만듭니다. `{ shell: 'shared' }`처럼 문자열을
주면 같은 라벨을 쓰는 그룹끼리 인스턴스를 공유합니다.

### 6.6 `intercept`로 설정만 주입

`ctx.intercept(name, config)`는 서비스 **구현을 바꾸지 않고** 그 아래 플러그인이 보는 서비스
설정만 병합합니다. 조상의 intercept가 먼저, 가까운 것이 나중에 적용됩니다.

### 6.7 이름 규칙

서비스 이름은 (격리하지 않는 한) 애플리케이션 전체에서 **하나의 평면 이름공간**입니다. dsh가
`tools`, `llm`, `agents`, `sessions` 같은 일반 이름을 이미 차지하고 있으므로, 플러그인
서비스는 접두사를 붙이십시오.

```ts
super(ctx, 'myPluginMetrics')     // 좋다
super(ctx, 'metrics')             // 충돌 위험
```

---

## 7. Event — 이름으로 통신

### 7.1 선언

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'my-plugin/ready': (payload: { id: string }) => void
    'my-plugin/check': (input: string) => boolean | undefined
    'my-plugin/transform': (input: string, next: () => Promise<string>) => Promise<string>
  }
}
```

이 선언은 타입만 제공합니다. 실제 emit/listen은 별도로 해야 합니다.

### 7.2 다섯 가지 디스패치 모드

| 모드 | 호출 | 대기 | 반환값 | 리스너 계약 |
| --- | --- | --- | --- | --- |
| `emit` | `ctx.emit(name, ...)` | 아니오 | 무시 | 동기 관찰 |
| `parallel` | `await ctx.parallel(name, ...)` | 모두 동시 | 없음 | 전부 settle 대기 |
| `serial` | `await ctx.serial(name, ...)` | 순서대로 | 첫 bail | 첫 유효 반환에서 중단 |
| `bail` | `ctx.bail(name, ...)` | 아니오 | 첫 bail | 동기 버전 serial |
| `waterfall` | `ctx.waterfall(name, ..., next)` | 체인 | 체인 결과 | **`next()` 필수** |

"bail 값"은 `null`, `false`, `undefined`가 **아닌** 모든 값입니다. `0`이나 `''`도 bail로
취급되니 주의하십시오.

- `parallel`은 모든 리스너를 `Promise.allSettled`로 기다린 뒤, 실패가 있으면 `AggregateError`를
  던집니다. 즉 "전부 실행은 되지만 호출자는 실패를 안다"는 계약입니다.
- `emit`/`bail`은 반환된 Promise를 기다리지 않습니다. **async 리스너가 reject하면
  unhandled rejection**이 되고, dsh에서는 fatal입니다. 비동기 작업이 필요하면 `parallel`을
  쓰거나 리스너 안에서 직접 오류를 처리하십시오.

```text
emit       core ──► A
                └─► B            (둘 다, 반환 무시)

parallel   core ──► A ─┐
                └─► B ─┴─► await all

serial     core ──► A ──await──► B ──await──► C
                              └─ 첫 bail에서 중단

waterfall  core ──► A ──next()──► B ──next()──► core
                       │
                       └─ next() 생략 = 여기서 종료(veto)
```

### 7.3 waterfall 계약

```ts
ctx.on('my-plugin/transform', async (input, next) => {
  const downstream = await next()   // 반드시 호출
  return downstream.trim()          // 반환값이 위로 전파
})
```

- `next()`를 호출하면 다음 리스너(마지막에는 내장 동작)로 위임합니다.
- 호출하지 않으면 **의도된 short-circuit**입니다. 이것이 게이트/차단의 구현 방법입니다.
- 하류 결과를 그대로 쓰려면 `return next()`로 반환값을 **반드시 돌려주십시오**. `next()`만
  호출하고 아무것도 반환하지 않으면 상류에는 `undefined`가 전파됩니다.
- `next()`의 반환값을 무시하고 새 값을 반환하면 하류 결과를 **교체**합니다.
- `next()`는 한 리스너에서 두 번 호출하면 `next() called multiple times` 예외가 납니다.

dsh에서 `agent/pre-step`, `tools/pre-execute`, `tools/post-execute`, `llm/stream`이 모두 이
모드입니다. 정책 리스너는 결정을 소유할 때 `next()`를 생략하고, 관찰/주석 리스너는 반드시
위임합니다.

### 7.4 등록과 옵션

```ts
const off = ctx.on('tools/result', handler)
const offOnce = ctx.once('agent/created', handler)

ctx.on('agent/pre-step', handler, { prepend: true })
ctx.on('agent/pre-step', handler, { global: true })
```

| 옵션 | 의미 |
| --- | --- |
| `prepend` | 기존 리스너보다 앞에 등록 |
| `global` | Context 필터를 우회해 모든 dispatch 수신 |

`ctx.on`이 돌려주는 disposer는 제거 여부를 `boolean`으로 반환합니다. `ctx.once`는 첫 호출
후 스스로 제거됩니다.

### 7.5 Context filter

Cordis는 dispatch 때마다 `Context.filter`를 조회합니다. dsh의 `@deepseek-ai/dsh-scope`가
바로 이 지점에 스코프 술어를 심습니다.

```text
dispatch (scopeTarget(agentA, ...))
   │
   ├─ untagged listener       → 수신
   ├─ tagged agentA           → 수신
   ├─ tagged ancestor         → 수신
   ├─ tagged sibling          → 차단
   └─ { global: true }        → 필터 우회, 수신
```

그래서 "왜 내 리스너가 특정 에이전트 이벤트를 못 받는가"의 답은 대개 **태그된 스코프**에
있습니다. 전역 관찰이 필요하면 `global: true`, 특정 에이전트만 필요하면 `agent.ctx`를
쓰십시오.

### 7.6 네이밍

dsh는 `namespace/action` 규칙을 씁니다.

```text
agent/pre-step, agent/created, agent/turn-stopping
tools/pre-execute, tools/result, tools/change
llm/stream, session/event, system-prompt/assemble
```

플러그인 이벤트도 같은 규칙을 따르면 로그와 카탈로그에서 읽기 쉬워집니다.

---

## 8. Composition — 코드와 YAML로 트리 만들기

### 8.1 코드로 마운트

```ts
export function apply(ctx: Context) {
  const fiber = ctx.plugin(childPlugin, { option: 1 })
  await fiber                       // 로드 완료 대기 (thenable)

  ctx.inject(['tools'], (ctx) => {  // 서비스 준비 후 1회 실행
    ctx.tools.register(myTool)
  })
}
```

| API | 의미 |
| --- | --- |
| `ctx.plugin(plugin, ...config)` | 플러그인 마운트, fiber 반환 |
| `ctx.inject(deps, cb)` | `inject + apply` 단축형, 의존성 변경 시 재실행 |
| `fiber.dispose()` | 그 인스턴스만 정리 |

`ctx.inject`는 편리하지만, 의존 서비스가 바뀔 때마다 콜백이 **다시 실행**된다는 점을
기억하십시오. 콜백 안에서 만든 자원은 effect로 소유해야 중복되지 않습니다.

### 8.2 YAML entry

```yaml
- id: metrics
  name: '@my-scope/dsh-metrics'
  config:
    interval: 5000

- id: extra-tools
  name: './src/index.ts'
  disabled: false

- id: experimental
  name: './src/experimental.ts'
  disabled: true
```

| 필드 | 의미 |
| --- | --- |
| `id` | 엔트리의 안정적 정체성. HMR diff의 기준 |
| `name` | 모듈 지정자(패키지명 또는 경로) |
| `config` | 플러그인에 전달할 설정 |
| `disabled` | 엔트리는 유지하고 마운트만 건너뜀 |
| `group` | 하위 엔트리 묶음 |
| `isolate` | 서비스 스코프 분리 |
| `intercept` | 서비스 설정 병합 |
| `inject` | 엔트리 수준 의존성 선언 |

`id`를 생략하면 읽을 때마다 새 id가 생성되어, 설정 파일을 조금만 고쳐도 그 엔트리가
제거+추가로 취급됩니다. **항상 명시적 `id`를 쓰십시오.**

### 8.3 그룹

```yaml
- id: sandboxed
  name: '@deepseek-ai/cordis-plugin-group'
  group: true
  isolate:
    shell: true
  config:
    - id: shell
      name: '@deepseek-ai/dsh-bash-local'
    - id: worker
      name: './src/worker.ts'
```

그룹은 하위 엔트리를 **하나의 단위**로 로드/언로드합니다. `disabled: true`를 그룹에 주면
하위 전체가 내려갑니다.

### 8.4 dsh의 레이어 합성

```text
빈 엔트리 목록
   │
   ├─ 1) profile의 dsh.profile.bundles (순서대로 patch 적용)
   ├─ 2) profile/cordis.patch.yml
   ├─ 3) $DSH_HOME/cordis.patch.yml
   └─ 4) --patch 오버레이
          │
          ▼
       cordis.yml (최종 entry 목록)
          │
          ▼
       Cordis Loader
```

patch의 동작은 **필드 단위 덮어쓰기**입니다.

- `id`로 대상 row를 찾아 patch에 적힌 키만 `target[key] = value`로 덮습니다.
- `config`를 적으면 그 필드가 **통째로 교체**됩니다(깊은 병합 아님).
- `name`을 함께 적으면 **가드**로 쓰입니다. 실제 row의 `name`과 다르면 경고하고 건너뜁니다.
- `insert:`는 새 row 목록을 덧붙입니다. `id`가 있으면 그 그룹의 `config` 끝에, 없으면 루트에
  삽입합니다.
- `id`가 없는 비-insert patch는 경고 후 무시됩니다.

그래서 같은 번들을 쓰면서 환경별로 설정만 바꿀 수 있습니다. `config`를 통째로 교체하는
성질 때문에, 일부 키만 바꾸고 싶어도 **바꿀 키를 포함한 전체 config**를 patch에 적어야
합니다.

### 8.5 HMR

```text
파일 저장
   │
   ▼
watcher ──► loader diff (id 기준)
   │
   ├─ 변경 없음 → 무시
   ├─ config만 변경 → update (필요 시 재마운트)
   └─ 코드 변경 → unload → effects unwind → 새 모듈 import → 새 fiber → inject 대기 → apply
```

HMR이 안전한 이유는 5절의 effect 규율 덕분입니다. 정리가 새는 플러그인은 HMR에서 리스너와
툴이 중복됩니다. "HMR에서 중복되면 effect 밖 등록이 있다"가 진단 규칙입니다.

dsh에서 HMR은 YAML이 결정합니다. 기본(base) 프로필은 config-only `dsh-hmr`를 켜고,
headless/SDK/ACP는 끄며 `sdk-minimal`은 아예 넣지 않습니다. profile patch로 이 기본값을
덮을 수 있습니다. HMR이 꺼진 표면에서는 코드/설정 변경에 재시작이 필요합니다.

---

## 9. Config — 검증된 입력

### 9.1 스키마

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  greeting: string
  targets: string[]
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  targets: Schema.array(String).default(['world']),
})

export function apply(ctx: Context, config: Config) { /* ... */ }
```

이름이 같은 인터페이스와 스키마를 함께 export하는 것이 관례입니다. 타입은 소비자에게,
검증기는 Cordis에게 갑니다. Cordis는 Standard Schema 호환이면 무엇이든 받습니다.

### 9.2 기본값과 실패

- 스키마 기본값이 채워진 **완전한 config**가 `apply`에 전달됩니다.
- 검증 실패는 `FAILED` fiber가 되고, 정확한 경로를 포함한 오류가 납니다.
- 플러그인은 스키마상 유효하지만 해석 불가능한 참조(없는 프로바이더 등)도 가능한 한 빨리
  거부해야 합니다.

### 9.3 volatile 필드

매 작업마다 읽는 값은 `.volatile()`로 선언합니다.

```ts
const Config = Schema.object({
  greeting: Schema.string().default('Hello').volatile(),
})

export function apply(ctx: Context, config: ReturnType<typeof Config>) {
  ctx.on('loader/volatile-update', (paths) => {
    console.log(config.greeting.get(), paths)
  })
}
```

- volatile 변경은 플러그인을 **재마운트하지 않고** 참조만 갱신합니다.
- 반드시 `.get()`으로 읽으십시오. 값을 지역 변수에 오래 보관하면 안 됩니다(한 작업 동안은
  괜찮습니다).
- 값은 깊게 동결된 스냅샷입니다. 함수/클래스 인스턴스/순환 참조는 거부됩니다.

### 9.4 `!!js`

Loader는 `!!js` 태그로 로드 시점 계산 값을 지원합니다.

```yaml
- id: my-plugin
  name: './src/index.ts'
  config:
    cwd: !!js process.cwd()
```

두 필드의 평가 시점과 문맥이 다릅니다.

| 필드 | 평가 시점 | 문맥 |
| --- | --- | --- |
| `config` | **선언된 inject가 활성화된 뒤**, 매 활성화마다 | 그 플러그인의 `fiber.ctx` |
| `disabled` | **매 마운트 결정마다** (inject 이전) | Loader 컨텍스트 |

그래서 `config`의 `!!js`는 다른 서비스(`ctx.serviceName`)에 의존하는 계산도 할 수 있지만,
`disabled`는 아직 플러그인이 없으므로 Loader 수준 정보만 볼 수 있습니다. `include`로 중첩된
row의 표현식은 대상 엔트리가 활성화될 때까지 보존됩니다. 환경별로 플러그인을 고르는 용도라면
`!!js`보다 patch 오버레이를 우선 고려하십시오.

---

## 10. dsh에서의 관례

### 10.1 서비스 vs 이벤트

| 하고 싶은 일 | 수단 |
| --- | --- |
| 능력을 직접 호출 | 서비스 메서드 (`ctx.tools.execute(batch)`) |
| 관찰/가로채기/정책 | 이벤트 (`tools/pre-execute`) |
| 상태 변경 알림 | 이벤트 (`agent/status`) |
| 구현 교체 | 서비스 seam + config |
| 재시작 후에도 남아야 하는 사실 | 세션 이벤트 (`session/event`) |

dsh의 원칙은 **"직접 능력 호출은 서비스, 개입과 정책은 이벤트"**입니다. 이벤트는 소비자를
모르게 하고, 서비스는 계약을 명시합니다.

### 10.2 durable과 live를 섞지 마라

Cordis 이벤트는 **프로세스 로컬**입니다. `agent/status`는 재시작하면 사라집니다. 반면
`turn/*`, `step/*`, `tool/call`, `tool/result`, `assistant/message`는 세션 로그에 남는
**durable record**이고 `session/event`로 관찰합니다.

모델이 본 것은 반드시 로그에 있어야 합니다. 자세한 내용은
[PLUGIN_MODEL.md 6절](./PLUGIN_MODEL.md#6-두-개의-평면-durable-vs-live)을 보십시오.

### 10.3 Client half도 Cordis다

브라우저 플러그인도 같은 `apply(ctx)` 계약을 씁니다. 다른 점은 로더입니다.

```text
Host:   Loader row  ──► import(module)  ──► plugin fiber  ──► inject(services)
Client: module graph ──► factory()       ──► plugin fiber  ──► inject(services)
```

`dsh.client.inject`는 **모듈 팩토리가 도착하는 순서**를 정합니다. Cordis의 `inject`는
**서비스가 준비되는 순서**를 정합니다. 둘은 별개이며, 그래서 client 모듈이 먼저 로드돼도
`theme` 서비스가 없으면 fiber는 PENDING에 머뭅니다.

### 10.4 initiator와 scope는 프레임워크가 아니다

`AgentRegistry`의 initiator 체인(`AsyncLocalStorage`)과 `dsh-scope`의 스코프 필터는 Cordis
코어 기능이 아니라 **dsh 패키지가 Cordis 위에 얹은 것**입니다. Cordis 관점에서는 그냥
서비스 하나와 `Context.filter` 술어 하나입니다. 이 구분을 알아야 문제를 어느 계층에서
찾을지 판단할 수 있습니다.

---

## 11. 진단

### 11.1 증상별 원인

| 증상 | 가능한 원인 | 확인 |
| --- | --- | --- |
| 아무 로그도 없다 | 필수 서비스가 없어 PENDING | `fiber.state`, `inject` 철자 |
| `FAILED` | `apply` 예외 또는 config 검증 실패 | stderr의 오류, `--dump-config` |
| HMR 후 리스너 중복 | effect 밖 등록 | 플러그인 끄고 켜서 재현 |
| 서비스가 `undefined` | 선택 의존인데 없음 / 철자 오류 | `ctx.get(name)` |
| 이벤트가 안 온다 | 스코프 필터 / 모드 불일치 | `global: true`로 테스트 |
| 프로세스가 즉시 종료 | PENDING만 있고 다른 작업 없음 | 상태 열거 |
| 설정 변경이 반영 안 됨 | volatile 아님 / 재마운트 필요 | `loader/volatile-update` |

### 11.2 fiber 상태 열거

`FiberState`는 **`const enum`**이라 런타임 객체가 없습니다. 값을 import할 수 없으므로, dsh
본체도 숫자 미러를 씁니다(`packages/boot/app-boot`의 `FIBER_PENDING` 등). 아래도 같은 방식입니다.

```ts
import type { Context, FiberState } from '@deepseek-ai/cordis'

// const enum이라 런타임 import가 없다. 선언 순서와 맞춰야 한다.
const PENDING = 0 as FiberState.PENDING
const ACTIVE = 2 as FiberState.ACTIVE

export function apply(ctx: Context) {
  setTimeout(() => {
    for (const runtime of ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        const label = fiber.state === PENDING ? 'PENDING'
          : fiber.state === ACTIVE ? 'ACTIVE'
          : String(fiber.state)
        console.log(fiber.name, label)
      }
    }
  }, 500)
}
```

`PENDING`은 "필수 서비스가 아직 없다"는 뜻이므로, 부팅 후에도 남아 있으면 `inject` 철자와
조합을 확인하십시오.

### 11.3 effect 열거

```ts
for (const runtime of ctx.registry.values()) {
  for (const fiber of runtime.fibers) {   // DisposableList: iterable, not Array
    console.log(fiber.name, fiber.getEffects())
  }
}
```

여기서 예상치 못한 라벨이 보이면 그 플러그인이 정리 의무를 제대로 선언하지 않은 것입니다.

### 11.4 dsh에서의 조합 확인

```sh
dsh --profile web --dump-config
```

- `# == <package>` 줄은 그 번들이 실제로 레이어에 있음을 뜻합니다.
- row의 `id`, `name`, `config`, `disabled`를 확인하십시오.
- 설치(`dsh plugin add`)와 활성화(`dsh.profile.bundles`)는 다릅니다.

---

## 12. 안티패턴

| 안티패턴 | 왜 나쁜가 | 대안 |
| --- | --- | --- |
| `effect` 밖에서 `setInterval` | unload 후에도 계속 실행, HMR 누수 | `ctx.effect` |
| `apply`에서 `void asyncWork()` | unhandled rejection이 프로세스 종료 | effect/jobs로 소유 |
| 서로 다른 effect의 disposer로 순서 의존 | top-level effect는 동시에 정리됨 | 한 effect 안에서 직렬로 묶기 |
| `ctx.get` 결과를 캐싱 | 제공자 교체 후 죽은 참조 | `inject` 또는 매번 조회 |
| 모든 이벤트를 `global: true`로 | 스코프 격리 무력화 | 필요한 곳만 |
| waterfall에서 `next()` 망각 | 파이프라인 조기 종료 | 의도한 veto만 |
| `id` 없는 YAML entry | HMR마다 재마운트 | 명시적 `id` |
| 흔한 서비스 이름 | 전역 이름 충돌 | 접두사 |
| `UNLOADING` 중 등록 | `INACTIVE_EFFECT` 또는 누수 | 등록은 `ACTIVE`까지 |
| 설정을 `apply`에서 복사해 보관 | volatile 갱신 무시 | 참조 유지 + `.get()` |

---

## 13. 치트시트

```ts
// 플러그인
export const name = 'my-plugin'
export const inject = ['tools']
export const Config = z.object({ /* ... */ })
export function apply(ctx: Context, config: Config) { /* ... */ }

// 서비스
declare module '@deepseek-ai/cordis' {
  interface Context { myService: MyService }
}
class MyService extends Service {
  constructor(ctx: Context) { super(ctx, 'myService') }
}

// 이벤트
declare module '@deepseek-ai/cordis' {
  interface Events {
    'my-plugin/changed': (payload: { id: string }) => void
  }
}
ctx.on('my-plugin/changed', handler)
ctx.emit('my-plugin/changed', { id })

// effect
ctx.effect(() => {
  const h = acquire()
  return () => h.release()
}, 'my-plugin: resource')

// 자식 플러그인
const fiber = ctx.plugin(child, childConfig)
await fiber

// 선택 의존
const svc = ctx.get('optionalService')

// 격리/오버라이드
const scoped = ctx.isolate('shell')
const configured = ctx.intercept('llm', { timeout: 30_000 })
```

| 개념 | 한 줄 |
| --- | --- |
| Context | 서비스 저장소 + 이벤트 버스 + 프록시 |
| Fiber | 플러그인 인스턴스의 상태·설정·effect 소유자 |
| Effect | 등록과 해제의 한 쌍 |
| Service | 이름으로 노출되는 능력 |
| Inject | 서비스 준비를 기다리는 선언 |
| Event | 이름으로 하는 느슨한 통신 |
| Waterfall | `next()`로 위임하는 파이프라인 |
| Isolate | 서비스 인스턴스를 그룹별로 분리 |
| Volatile | 재마운트 없이 갱신되는 설정 참조 |
| Loader | YAML entry를 fiber로 마운트하는 합성기 |

### 더 읽을 것

하네스 저장소의 1차 자료:

| 문서 | 내용 |
| --- | --- |
| `docs/cordis-primer.md` | 다섯 아이디어와 디스패치 모드 요약 |
| `docs/cordis-api/context.md` | Context API 전체 |
| `docs/cordis-api/fiber.md` | Fiber와 effect 계약 |
| `docs/cordis-api/events.md` | 이벤트 디스패치 API |
| `docs/cordis-api/registry.md` | plugin/inject 타입 |
| `docs/cordis-api/service.md` | Service 클래스 |
| `docs/cordis-tutorial/01~07` | 단계별 실습 |
| `docs/user/develop/framework/service.md` | 서비스 격리 예제 |
| `vendor/cordis/src/fiber.ts` | 상태 기계와 effect 구현 |

이 문서를 읽은 뒤 [PLUGIN_MODEL.md](./PLUGIN_MODEL.md)로 넘어가면, Cordis의 일반 개념이
에이전트 코어에서 어떻게 구체화되는지(스코프, inbox, pre-step, 툴 파이프라인) 연결됩니다.
