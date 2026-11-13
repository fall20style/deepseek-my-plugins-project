# 플러그인 모델 (Plugin Model)

이 문서는 **"에이전트 코어와 플러그인은 어떻게 통신하는가"**, 그리고 **"Cordis는 그 안에서
정확히 무슨 역할을 하는가"**에 대한 답입니다. `deepseek-my-plugin` 하나를 설명하는 문서가
아니라, 툴·정책·오케스트레이션·UI처럼 코어의 상태 기계에 직접 개입해야 하는 플러그인을
설계하기 위한 **통신 모델** 문서입니다.

- 기준 버전: `0.2.2-rc.1`
- 경로 표기: 하네스 체크아웃은 `$HARNESS`, 사용자 홈은 `$DSH_HOME`(`~/.dsh`)
- 예제 패키지: `deepseek-my-plugin/`

관련 문서:

- [ARCHITECTURE.md](./ARCHITECTURE.md) — profile/bundle 합성, Host/Client 이중 구조, 모듈 로더, 슬롯
- [CORDIS.md](./CORDIS.md) — Cordis 프레임워크 자체의 구조와 사용법
- [IMPLEMENTATION-GUIDE.md](./IMPLEMENTATION-GUIDE.md) — 실제 작성 레시피와 체크리스트
- [TUTORIAL.md](../TUTORIAL.md) — 처음부터 만드는 입문 가이드

> 이 문서의 코드는 **계약을 보여 주는 축약형**입니다. 정확한 필드 타입은 하네스의
> `docs/subsystems/core.md`, `docs/subsystems/tools.md`, `docs/architecture.md`가 기준입니다.

---

## 0. 30초 요약

| 계층 | 소유하는 것 | 플러그인이 닿는 방법 |
| --- | --- | --- |
| **Cordis** | 서비스 키, fiber 수명, effect 정리, 이벤트 디스패치, 로더 합성 | `inject`, `ctx.<service>`, `ctx.on`, `ctx.effect` |
| **에이전트 코어** | `Agent` 상태 기계, inbox, 턴/스텝, 세션 로그, 툴 파이프라인 | `ctx.agents`, `agent.*`, `agent/*`·`tools/*` 이벤트 |
| **플러그인** | 정책, 기능, 표현, 오케스트레이션 | 위 두 계층이 노출한 계약만 사용 |

한 문장으로:

> **Cordis는 배선(wiring)과 수명(lifetime)을 소유하고, 에이전트 코어는 상태 기계(state
> machine)와 로그(log)를 소유한다. 플러그인은 서비스·이벤트·스코프라는 세 통로로만 코어에
> 닿으며, 코어는 어떤 플러그인이 자기를 확장하는지 모른다.**

이 "코어가 플러그인을 모른다"는 사실이 핵심입니다. 코어는 `ctx.tools`, `ctx.agents`,
`agent/pre-step` 같은 **빈 확장점**만 선언하고, 실제 정책은 전부 밖에서 붙습니다. 그래서
같은 코어로 Web UI, headless, ACP, SDK가 모두 만들어집니다.

---

## 1. 전체 지도

```text
+-- L4 표현 계층 ------------------------------------------------------------
|  web app (browser)   desktop shell   CLI/headless   ACP   SDK
|     |                    |              |            |      |
|     | client modules     |              |            |      |
+-- L3 전송/호스트 ----------------------------------------------------------
|  webserver / server / connection / client-modules / remote-access
|     ^  HTTP, SSE, JSON-RPC
+-- L2 코어 (모든 조합이 부팅하는 패키지) ------------------------------------
|  session  <-- session/event --  agent-loop  --  agent
|  (durable log)                  (driver)        (Agent, AgentRegistry)
|     ^                             |   ^             ^
|     |                             |   |             |
|  session-projection           tools  system-prompt  llm
|  (fold/read model)      (registry+pipeline)  (prompt)  (adapters)
+-- L1 Cordis 런타임 --------------------------------------------------------
|  Context tree · services · events (4 modes) · effects · fibers · rows
+-- L0 합성 계층 ------------------------------------------------------------
|  profile/package.json (dsh.profile.bundles)
|    -> cordis.yml -> patch layers (profile -> home -> --patch)
|  row 하나 = 플러그인 하나 = fiber 하나
+---------------------------------------------------------------------------
```

읽는 순서는 **L0 → L1 → L2**입니다. 프로필이 "이 배포판에 어떤 능력이 있는가"를 정하고,
Cordis가 그 능력들을 서비스 그래프로 엮고, 코어 패키지가 그 위에서 에이전트를 돌립니다.
플러그인은 L1의 API로 L2에 붙고, L3/L4는 L2의 이벤트와 서비스를 소비합니다.

**중요:** 플러그인은 `@deepseek-ai/dsh-agent-loop`를 import하지 않습니다. 코어 패키지
사이의 의존은 "서비스 정의"와 "이벤트 선언"으로만 표현됩니다. 그래서 드라이버를 바꿔도
플러그인은 그대로 동작합니다.

---

## 2. Cordis의 네 가지 역할

Cordis는 프레임워크라기보다 **의존성 주입 컨테이너 + 수명 관리기 + 이벤트 버스 + 로더**의
조합입니다. 네 역할을 분리해서 보면 이해가 빠릅니다.

### 2.1 역할 1 — 서비스 레지스트리 (DI)

서비스는 **문자열 키**로 등록되고, 소비자는 선언적으로 기다립니다.

```ts
// 제공자
export default class MetricsService extends Service {
  static inject = ['llm']        // 서비스도 다른 서비스에 의존한다
  constructor(ctx: Context) {
    super(ctx, 'metrics')        // 키: 'metrics'
  }
}

// 소비자
export const inject = ['metrics'] // 'metrics'가 생길 때까지 fiber는 PENDING
export function apply(ctx: Context) {
  ctx.metrics.record('boot', 1)
}
```

```text
            +------------------------------+
            |  Context (fiber-scoped)      |
            |                              |
            |  tools   -> ToolsService     |
            |  agents  -> AgentRegistry    |
            |  llm     -> LlmRuntime       |
            |  sessions-> SessionStore     |
            |  metrics -> MetricsService   |  <-- 당신의 서비스
            +------------------------------+
                    ^                ^
      inject:['tools']         inject:['metrics']
                    |                |
              +-----+-----+    +-----+------+
              | tool-fs   |    | my-plugin  |
              +-----------+    +------------+
```

핵심 규칙:

- `inject`는 **선언이지 초기화 순서 수동 조정이 아닙니다.** 서비스가 없으면 fiber는
  `PENDING`에 머물고, 서비스가 생기면 자동으로 `LOADING → ACTIVE`가 됩니다.
- 서비스가 **사라지면 소비자는 자동으로 내려갑니다.** 제공자 재시작 시 소비자도 재시작됩니다.
- 선택 의존은 `ctx.get('metrics')`로 조회합니다. 없으면 `undefined`입니다.
- 같은 키를 그룹별로 분리하려면 `cordis.yml`의 `isolate`를 씁니다.

서비스 키는 **전역 이름공간**입니다. `metrics` 같은 흔한 이름을 쓰기 전에, 정말 전역
서비스인지 아니면 `agent.ctx`에 붙는 스코프 기능인지 먼저 판단하십시오(3.4절).

### 2.2 역할 2 — 수명 소유자 (fiber + effect)

플러그인의 모든 등록은 **effect**입니다. effect는 "이 fiber가 내려갈 때 같이 정리되는
것"을 뜻합니다.

```ts
export function apply(ctx: Context) {
  ctx.tools.register(myTool)              // effect: 자동 해제
  ctx.on('tools/result', onResult)        // effect: 자동 해제
  const timer = setInterval(poll, 1000)
  ctx.effect(() => () => clearInterval(timer), 'my-plugin: poll timer')
}
```

```text
root fiber
  |
  +-- plugin A fiber
  |     +-- tool registration      (effect)
  |     +-- event listener         (effect)
  |     +-- child plugin fiber     (재귀적으로 함께 내려감)
  |
  +-- plugin B fiber
        +-- service 'metrics'      (effect)
        +-- HTTP route             (effect)
```

fiber 상태 기계:

```text
               서비스 등장
   PENDING ───────────────► LOADING ──apply 성공──► ACTIVE
      ▲                        │                     │
      │                        │ apply 예외           │ 소유자 unload
      │                        ▼                     ▼
      └── 서비스 소멸 ────── FAILED              UNLOADING
                                                   │
                                                   ▼
                                               DISPOSED
```

이 모델이 주는 실질적 이점:

1. **정리 누락이 구조적으로 불가능**합니다. 등록과 해제가 한 쌍입니다.
2. **HMR이 안전**합니다. 코드를 고치면 fiber만 내렸다 올리면 됩니다.
3. **부분 실패가 격리**됩니다. optional row가 실패해도 형제는 살아 있습니다.

주의할 점도 있습니다.

- `apply`가 반환한 Promise가 settle될 때까지가 초기화 구간입니다.
- **`apply` 밖으로 새어 나간 비동기 작업의 unhandled rejection은 프로세스를 종료**시킵니다.
  장기 작업은 반드시 `ctx.effect` 또는 `ctx.jobs`로 소유하십시오.
- 정리는 등록 역순으로 **시작**되지만, 여러 async disposer는 **동시에** 실행됩니다.
  순서가 중요하면 `ctx.effect` 하나 안에서 직렬로 처리하십시오.

### 2.3 역할 3 — 이벤트 버스 (4모드)

Cordis 이벤트는 "누가 누구를 호출하는가"를 뒤집습니다. 코어는 리스너를 모른 채
`ctx.emit(...)`/`ctx.waterfall(...)`만 호출하고, 플러그인은 선언만 합니다.

| 모드 | 디스패치 의미 | 리스너 계약 | 대표 이벤트 |
| --- | --- | --- | --- |
| `emit` | 동기 브로드캐스트, 반환값 무시 | 아무것도 반환하지 않음, 예외는 격리 | `agent/status`, `tools/result` |
| `bail` | 순서대로, 첫 비-`null` 값이 결과 | 값을 반환하면 중단 | (드묾) |
| `serial` | 순서대로, async 대기 | 첫 비-`null` 값이 중단 | `agent/created`, `agent/turn-stopping` |
| `waterfall` | 파이프라인, `next()`로 위임 | **반드시 `next()` 호출** | `agent/pre-step`, `tools/pre-execute` |

```text
emit       core ──► listener A
                └─► listener B            (둘 다 실행, 반환값 없음)

serial     core ──► A ──await──► B ──await──► C
                              └─ 첫 유효 반환에서 중단

waterfall  core ──► A ──next()──► B ──next()──► core
                       │
                       └─ next()를 안 부르면 여기서 파이프라인 종료
                          (= 의도된 게이트/차단)
```

`waterfall`에서 `next()`를 빼먹는 것은 버그가 아니라 **게이트웨이 동작**입니다. 예를 들어
`agent/pre-step`에서 `next()`를 부르지 않고 `{ kind: 'reject' }`를 반환하면 그 스텝은
승인되지 않습니다.

이벤트 타입은 declaration merging으로 붙입니다.

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'my-plugin/ready': (payload: { id: string }) => void
    'my-plugin/check': (input: string) => boolean | undefined
  }
}
```

### 2.4 역할 4 — 합성 로더 (composition)

프로필은 **불러오는 순서가 있는 레이어 목록**입니다.

```text
$DSH_HOME/profiles/web/package.json
  dsh.profile.bundles: ["@deepseek-ai/dsh-base", "dsh-web-app", "deepseek-my-plugin"]
        │
        ▼
번들 순서대로 patch 적용
        │
        ▼
profile/cordis.patch.yml  →  $DSH_HOME/cordis.patch.yml  →  --patch 오버레이
        │
        ▼
cordis.yml (entry row 목록)
        │
        ▼
Cordis Loader: row 하나당 fiber 하나
```

플러그인 입장에서 중요한 결론:

- **`dsh plugin add`는 의존성만 추가**합니다. 번들 레이어 활성화는
  `dsh.profile.bundles`(또는 Plugins UI)가 담당합니다.
- row의 `name`이 **패키지 이름 그대로**여야 client half가 발견됩니다.
- 번들 순서가 곧 "누가 누구를 덮어쓰는가"입니다.

### 2.5 Cordis가 **아닌** 것

오해를 막기 위해 명시합니다.

| 오해 | 실제 |
| --- | --- |
| 샌드박스/권한 경계 | 아니다. 플러그인은 같은 프로세스의 신뢰 코드다. |
| 프로세스 간 메시지 버스 | 아니다. 이벤트는 프로세스 로컬이다. |
| 에이전트 상태 저장소 | 아니다. durable 상태는 세션 로그가 소유한다. |
| "아무 서비스나 스코프로 격리" | 아니다. 스코프 인식 API만 격리된다(3.4절). |
| 재시작/큐/영속성 | 아니다. 필요하면 세션 이벤트나 별도 서비스로 직접 만든다. |

특히 마지막 항목이 중요합니다. `agent/status` 같은 라이브 이벤트는 **프로세스가 죽으면
사라집니다.** 재시작 후에도 남아야 하는 사실은 반드시 `session/event`로 기록해야 합니다.

---

## 3. 에이전트 코어의 공개 표면

### 3.1 패키지 분업

| 패키지 | 공개 표면 | 플러그인이 의존해도 되는가 |
| --- | --- | --- |
| `dsh-session` | `ctx.sessions`, `Session`, `session/event` | 예 (durable 계약) |
| `dsh-agent` | `Agent`, `AgentHandle`, `ctx.agents`, `agent/*` 선언 | **예 (권장)** |
| `dsh-agent-loop` | 구체 드라이버, `AgentFactory` 구현 | **아니오** (교체 가능) |
| `dsh-tools` | `ctx.tools`, `tools/*` 이벤트, 파이프라인 | 예 |
| `dsh-system-prompt` | `ctx.systemPrompt`, `system-prompt/assemble` | 예 |
| `dsh-llm` | `ctx.llm`, `llm/stream`, 메시지 타입 | 예 |

`AgentFactory`는 `ctx.agents.setFactory()`로 등록됩니다. 즉 **생성 능력조차 서비스**이고,
소비자는 `ctx.agents.create()`만 알면 됩니다. 이것이 "드라이버 교체 가능"의 구현입니다.

```text
consumer plugin ──► ctx.agents.create(options) ──► AgentRegistry
                                                       │
                                                       │ factory (등록된 것)
                                                       ▼
                                              dsh-agent-loop
                                                       │
                                                       ▼
                                              AgentHandle + Agent
```

### 3.2 Agent / AgentHandle / AgentRegistry

세 타입의 역할을 분리해서 기억하십시오.

```text
+-------------------+        +---------------------+        +----------------------+
|  AgentRegistry    |        |    AgentHandle      |        |        Agent         |
|  (ctx.agents)     |        |  (owner-only)       |        |  (everyone)          |
+-------------------+        +---------------------+        +----------------------+
| create()          |───────►| agent: Agent        |───────►| id / session         |
| resume()          |        | dispose(): Promise  |        | options / model      |
| get(id) / list()  |        +---------------------+        | inbox / status / ctx |
| currentInitiator()|                                       | send/followup/steer  |
| withInitiator()   |                                       | inject/cancel        |
| turnBoundaryOf()  |                                       | whenIdle/runMaint.   |
+-------------------+                                       +----------------------+
```

- `ctx.agents.get(id)`는 **bare Agent**를 돌려줍니다. `AgentHandle`은 생성한 소유자에게만
  주어지는 **정리 능력(capability)**입니다.
- `Agent.ctx`는 그 에이전트 전용 Context입니다(3.4절).
- `Agent.session`은 durable log입니다. `Agent.inbox`는 durable projection입니다.
- `whenIdle()`은 "지금 활동이 모두 끝날 때까지"를 기다립니다. 특정 메시지의 완료를
  식별하지는 않습니다.
- `runMaintenance(task)`는 턴이 아닌 유지보수 작업을 idle 구간에서 실행합니다.
  백그라운드 인덱싱/정리 같은 작업에 쓰십시오.

### 3.3 생성과 해체 순서

`create()`/`resume()`은 **롤백 가능한 트랜잭션**입니다. 순서를 이해하면 "왜 내 리스너가
첫 스텝을 못 봤는가" 같은 문제를 피할 수 있습니다.

```text
create(options)
  │
  ├─ [1] Session store 진입 + session/created
  ├─ [2] setup(agentCtx, agent)          <-- 여기서 스코프 등록
  ├─ [3] Registry enter (아직 미공개)
  ├─ [4] serial agent/created            <-- 전역 리스너가 여기서 붙음
  ├─ [5] 대기 중이던 입력 release
  └─ resolve(AgentHandle)
```

해체는 역순입니다.

```text
handle.dispose()
  ├─ 드라이버 stop + drain (진행 중 턴 종료 대기)
  ├─ 스코프 unwind (agent.ctx의 모든 등록 해제)
  ├─ 세션 write path close
  ├─ agent/disposed
  └─ 세션 detach
```

실패 시: setup/commit/listener 실패 또는 소유자 dispose는 준비된 자원을 롤백하고,
이미 저장된 이벤트와 복원된 pending input은 보존합니다.

**실무 규칙:** per-agent 기능은 `agent/created`에서 `agent.ctx`에 붙이십시오. 그러면
첫 프롬프트 조립 전에 준비되고, 에이전트가 사라질 때 자동으로 정리됩니다.

### 3.4 `agent.ctx` — 에이전트별 스코프

`agent.ctx`는 **그 에이전트에게만 보이는 등록 세계**입니다. 툴, 프롬프트 섹션, 변수,
이벤트 리스너, 제한(restriction) 모두 여기에 붙일 수 있습니다.

```text
plugin fiber (전역)
  │
  ├─ ctx.tools.register(globalTool)        모든 에이전트에 보임
  │
  ├─ agentA.ctx.tools.register(toolA)      agentA에게만 보임
  ├─ agentA.ctx.on('agent/pre-step', hA)   agentA의 스텝만
  │
  └─ agentB.ctx.tools.register(toolB)      agentB에게만 보임
```

스코프의 두 방향 규칙:

```text
등록 가시성 (아래로 상속)              이벤트 수신 (위로 확장)
                                      
  global layer                          listener @ agentA
      │                                      ▲
      ▼                                      │
  scopeA layer  ──► agentA는 global+scopeA   │  agentA 이벤트
      │                                      │
      ▼                                      │
  scopeA.child ──► child는 전부 보임     listener @ agentA는
                                          descendant 이벤트도 받음
```

- **등록은 아래로 상속**됩니다. 자식 스코프는 조상의 등록을 봅니다. 역방향은 없습니다.
- **이벤트는 위로 확장**됩니다. 조상에 태그된 리스너는 자손의 이벤트를 받습니다. 역방향은
  없습니다.
- 스코프를 dispose하면 그 스코프를 통해 등록된 모든 것이 함께 해제됩니다.

타입 수준에서는 `Scoped<Agent>` 브랜드가 붙습니다. 스코프 필터 이벤트의 `this` 타입이
carrier이므로, **carrier 없이 subject만 넘겨서 dispatch하는 것은 컴파일 에러**입니다.

> **함정:** `agent.ctx`를 통해 등록하면 *effect*가 스코프됩니다. 하지만 이벤트
> *dispatch*의 스코프 필터링은 carrier(`scopeTarget(agent, agent)`)를 명시해야 동작합니다.
> 즉 "등록은 스코프, 전달은 carrier"입니다. 라이브러리를 직접 만들 때 이 둘을 혼동하지
> 마십시오.

스코프는 **격리 장치이지 권한 장치가 아닙니다.** `agent.ctx`를 넘겨주는 것은 그 플러그인의
서비스 해석 능력까지 넘겨주는 것입니다. 신뢰 경계로 쓰지 마십시오.

### 3.5 inbox — 두 개의 큐, 네 가지 동사

에이전트로 들어가는 모든 입력은 **durable inbox**를 거칩니다. 두 개의 순서 있는 리스트가
있습니다.

```text
Agent.inbox
  nextTurn : UserMessage[]   "다음 턴의 프롬프트"
  nextStep : UserMessage[]   "다음 스텝 경계의 입력/컨텍스트"

      ^                         ^
      |                         |
  followup()              steer() / inject()
  (큐 + wake)             (큐 + wake / 큐만)
```

| 동사 | 대상 | 드라이버 wake | 의미 |
| --- | --- | --- | --- |
| `followup(msg)` | `nextTurn` | **예** | 독립된 다음 턴을 연다 |
| `steer(msg)` | `nextStep` | **예** | 진행 중 턴의 다음 스텝에 개입한다 |
| `inject(msg)` | `nextStep` | **아니오** | 모델이 볼 컨텍스트만 추가한다 |
| `send(msg, target, wakeup)` | 지정 | 지정 | 위 셋의 일반형 |

스텝 경계에서의 claim 규칙:

```text
스텝 경계 도달
  ├─ nextStep의 모든 메시지를 claim
  └─ 턴 경계이면 nextTurn에서 하나만 claim

claim된 메시지는 inbox에서 제거되고
  ├─ agent/inbox/claimed  (live)
  └─ user/message         (durable, 승인된 경우)
```

중요한 성질:

- 모든 inbox 변경은 **정규화된 `agent/inbox/spliced` 세션 이벤트**로 기록됩니다.
  그래서 라이브 프로젝션과 콜드 재생이 같은 결과를 냅니다.
- `inject`는 **wake하지 않습니다.** idle 에이전트에 inject하면 그 메시지는 다음
  `followup`/`steer`가 올 때까지 pending입니다.
- `agent/pre-step`이 스텝을 거부하면 claim된 메시지는 **discard도 재기록도 없이** 거기서
  끝납니다. 턴은 스텝 없이 닫힙니다.
- `cancel(cause, { keepInbox })`는 진행 중 활동을 중단합니다. `keepInbox`가 없으면 pending
  입력을 지웁니다. cause는 `user | parent | hook | disposed`입니다.

메시지를 만들 때는 `createUserMessage({ content, source })`를 쓰십시오. id는 자동으로
발급됩니다. `source.kind`는 **merge-extensible**이므로, 자기 플러그인의 kind를 모듈 확장으로
선언하는 것이 정석입니다.

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'my-plugin': { kind: 'my-plugin'; task: string }
  }
}
```

그래야 UI/telemetry가 "누가 이 컨텍스트를 넣었는가"를 잃지 않습니다.

---

## 4. 한 턴의 생애

에이전트는 **step**과 **turn**으로 움직입니다.

- **step** = 모델 요청 1회 + 그 요청이 부른 툴들
- **turn** = 0개 이상의 step. 첫 입력을 claim하기 전에 열리고, 아무것도 남지 않으면 닫힌다.

```text
[입력]  followup() / steer() / inject()
   |
   v
(1) turn/start  [D]
    - nextStep 전체 + nextTurn 1개 claim
    - 모델 선택 스냅샷 (provider/model/effort)
    - 프롬프트 섹션 + 승인 툴 스키마 조립
   |
   v
(2) agent/pre-step  [L waterfall]
    payload: { agent, messages, turn, step, signal, modelSelection }
    next() -> { kind:'enter', messages, startsRequestSeries? }
           -> { kind:'reject' }
    * 거부 또는 빈 enter -> 스텝 없이 턴 종료
   |
   v
(3) step/start  [D]
    agent/request (deprecated)  [L waterfall]
      -> prepareCall(): 어댑터 바인딩, 기본값 해석
    system/message 재조정, user/message 커밋  [D]
    request/header, request/context  [D]
    로그에서 모델 히스토리 유도 + freeze
   |
   v
(4) llm/stream  [L waterfall]
    agent/assistant-stream start  [L emit]
      chunk ...                    [L emit]
    assistant/message | assistant/attempt  [D]
    agent/assistant-stream end    [L emit]
   |
   v
(5) tool/call  [D]
    tools/pre-execute -> guards -> approval -> tools/execute
      -> tool body -> projectContent -> tools/post-execute
      -> finalizeContent -> tools/result [L] -> tool/result [D]
   |
   v
(6) step/end  [D]
    툴이 다음 요청을 요구하거나 nextStep 입력이 있으면 -> (3)
   |
   v  (더 없음)
(7) agent/turn-stopping  [L serial]
    리스너가 agent.steer()로 턴을 연장할 수 있다
   |
   v
(8) turn/end  [D]
```

`[D]` = durable session event, `[L]` = live Cordis event.

플러그인이 개입할 수 있는 지점을 정리하면:

| 지점 | 모드 | 할 수 있는 일 | 할 수 없는 일 |
| --- | --- | --- | --- |
| `agent/created` | serial | per-agent 스코프 구성, 첫 입력 전 준비 | 에이전트 구동(drive) |
| `agent/pre-step` | waterfall | 메시지 거부/치환, 요청 시리즈 분리 | 모델/프로바이더 선택 변경 |
| `agent/request` | waterfall | 샘플링 등 제어값 조정 | 메시지 변경, route 변경 (deprecated) |
| `llm/stream` | waterfall | 스트림 래핑/관찰 | durable 기록 우회 |
| `tools/pre-execute` | waterfall | allow/deny/ask/cancel | 인자 재작성(이미 로그됨) |
| `tools/execute` | waterfall | 타임아웃/재시도/메트릭 래핑 | call identity 변경 |
| `tools/post-execute` | waterfall | 결과 수용/교체/차단/컨텍스트 추가 | 툴 실행 자체 취소 |
| `tools/result` | emit | 최종 결과 관찰 | 결과 변경 |
| `agent/turn-stopping` | serial | steer로 턴 연장 | 순서로 결과 뒤집기 |
| `agent/request-error` | waterfall | `{ kind:'retry' }`로 재시도 소유 | 실패 은폐 |

주의: `agent/request`는 **deprecated**입니다. 새 코드는 `agent.model.select()`(스텝 준비 전)와
`AgentOptions.maxTokens`를 쓰십시오. `agent/request`는 provider/model/effort를 **바꿀 수
없고**, 메시지도 바꿀 수 없습니다.

---

## 5. 도구 실행 파이프라인

툴 호출은 코어에서 가장 많은 정책이 겹치는 지점입니다. 순서를 외우는 것보다 **어느
단계가 무엇을 보장하는가**를 이해하는 것이 중요합니다.

```text
assistant message에 tool-call 블록
        │
        ▼
  tool/call  [D]  ← 실행 전에 이미 로그됨
        │
        ├──────────────► UI pending card (presentCall(args))
        ▼
  tools/pre-execute  [L waterfall]   allow / deny / ask / cancel
        │  (next() = allow 위임)
        │
        +-- allow ─────────────────────────────► guards
        │                                            │
        +-- ask ──► ctx.approval (1회 승인)           │ allow
        │             ├─ allowed-once ──────────────►┤
        │             └─ 거부/불가 ──┐                │
        │                            │                ▼
        +-- deny / cancel ───────────┤        tools/execute  [L waterfall]
                                     │        (timeout/retry/metrics 래퍼)
                                     │                │
                                     │                ▼
                                     │        tool body  execute()
                                     │          (fs 쓰기면 fs/write-intent,
                                     │           fs/edit-intent 게이트)
                                     │          (툴 소유 세션 이벤트:
                                     │           todo/write, fs/observed ...)
                                     │                │
                                     │                ▼
                                     +------► ToolDefinition.projectContent
                                                      │
                                                      ▼
                                              tools/post-execute  [L waterfall]
                                                accept / replace / block
                                                additionalContexts
                                                      │
                                                      ▼
                                            정규화 (스냅샷 실패 -> isError)
                                                      │
                                                      ▼
                                            ToolDefinition.finalizeContent
                                                      │
                                                      ▼
                                            tools/result  [L emit]
                                                      │
                                                      ▼
                                            tool/result  [D]  ← 모델이 보는 결과
                                                      │
                                                      ├────► UI completed card
                                                      └────► 배치 완료 대기
                                                                  │
                                                                  ▼
                                                    additionalContexts를
                                                    user/message로 기록
```

설계 규칙:

- **`tools/pre-execute`는 정책, `tools/execute`는 실행 래핑, `tools/post-execute`는 결과
  변형**입니다. 관심사를 섞지 마십시오.
- 인자 재작성은 금지됩니다. 인자는 이미 `tool/call`로 로그되었고 UI에 제시되었습니다.
  입력을 바꾸고 싶다면 **툴 정의 단계**에서 처리하십시오.
- `deny`는 모델에게 보이는 사유를 만듭니다. `cancel`은 정책 거부가 아닌 정규 취소 결과를
  선택합니다. 둘은 의미가 다릅니다.
- monotonic guard는 **거부만 가능**합니다. 리스너 순서로 거부를 허용으로 되돌릴 수
  없습니다. 보안상 중요한 규칙은 waterfall이 아니라 guard로 두십시오.
- `tools/result`는 이미 동결된 결과를 받습니다. 여기서 바꾸려 하면 안 됩니다.
- `tool/result` durable 이벤트가 **모델이 보는 유일한 결과**입니다. 여기에 들어가지 않은
  것은 다음 스텝에 존재하지 않습니다.

`concludesTurn: true`를 가진 성공 결과는 그 배치 커밋 후 턴을 끝냅니다. 반대로 턴을 더
열고 싶으면 `agent/turn-stopping`에서 steer하십시오.

---

## 6. 두 개의 평면: durable vs live

이 문서에서 가장 중요한 구분입니다.

```text
DURABLE PLANE — 세션 로그                LIVE PLANE — Cordis 이벤트
------------------------------------     ------------------------------------
session/event 로 관찰                    ctx.on(...) 으로 관찰
재시작/포크/재생/텔레메트리의 근거          진행 중 UI/정책/조정의 근거
turn/*, step/*, user/message            agent/*, tools/*, llm/*
assistant/*, tool/call, tool/result     system-prompt/*, fs/*, ...
추가하려면 Session append 필요            추가하려면 Events 선언 + emit
------------------------------------     ------------------------------------
            |                                        |
            | 파생(derive)                            | 관찰/개입
            v                                        v
   모델 히스토리, 트랜스크립트                 UI, 정책, 오케스트레이션
```

규칙:

1. **"모델이 본 것은 반드시 로그에 있다."** 모델 가시 입력을 추가하려면 세션 이벤트를
   추가해야 합니다. 라이브 이벤트만 emit하면 재생/포크에서 사라집니다.
2. **라이브 이벤트는 표현 데이터다.** `agent/assistant-stream`의 chunk는 UI 증분을 위한
   것이고, 재생 소스는 `assistant/message`입니다.
3. **durable 상태를 직접 만들지 말고 projection을 써라.** `ctx.sessionProjections`에
   등록하면 콜드 재생과 라이브가 같은 fold를 공유합니다. `AgentLoop`의 inbox와 model
   selection이 그 예입니다.
4. **live 이벤트에 권위를 두지 마라.** `agent/status`는 편의 정보다. 진짜 턴 경계는
   `ctx.agents.turnBoundaryOf(session)`으로 읽습니다.

| 질문 | 평면 | API |
| --- | --- | --- |
| 재시작 후에도 남아야 하나? | durable | 세션 이벤트 append + projection |
| 지금 이 순간 UI에 보여야 하나? | live | `agent/*` emit 구독 |
| 다음 요청 내용을 바꿔야 하나? | durable 경유 | `agent/pre-step`, `createUserMessage` |
| 실행을 차단해야 하나? | live | `tools/pre-execute` + guard |
| 특정 에이전트에만 적용해야 하나? | scope | `agent.ctx` |
| 프로세스 밖으로 보내야 하나? | 전송 계층 | server/remote-access/SDK |

---

## 7. 인과 귀속(attribution)과 스코프 필터

### 7.1 initiator chain

에이전트가 시작한 비동기 작업은 "누가 시켰는가"를 계속 들고 다녀야 합니다. Cordis는 이걸
`AsyncLocalStorage` 체인으로 해결합니다.

```text
driver (agentA)
   │  ctx.agents.withInitiator(agentA, () => work())
   ▼
work() ──► helper() ──► ctx.agents.currentInitiator() === agentA
   │
   ├─ withInitiator(agentB, ...)  → 그 구간만 agentB
   └─ withoutInitiator(...)       → 구간만 undefined
```

- `currentInitiator()`는 **선택적** 조회입니다. 에이전트 없는 호출도 지원합니다.
- `requireInitiator()`는 경계가 없으면 던집니다. 드라이버 아래의 private helper에 씁니다.
- `withoutInitiator()`는 타이머/큐 펌프/익스포터가 **엉뚱한 첫 에이전트를 상속하지
  않도록** 할 때 씁니다.
- 이 귀속은 **같은 프로세스 안에서만** 유효합니다. worker/프로세스/큐/재시작 경계에서는
  명시적 identity를 전달해야 합니다.

> **오해 금지:** initiator의 존재는 liveness 증명도, 권한도 아닙니다. "이 작업을 시작한
> 에이전트"일 뿐입니다. 접근 제어는 별도로 설계하십시오.

### 7.2 스코프 필터가 실제로 거르는 것

`agent/*`와 `tools/*`는 **scope-filtered dispatch**입니다.

```text
dispatch: scopeTarget(agentA, payload)
   │
   ├─ untagged listener        → 항상 수신
   ├─ listener tagged agentA   → 수신
   ├─ listener tagged ancestor → 수신 (위로 확장)
   ├─ listener tagged sibling  → 차단
   └─ listener tagged child    → 차단 (역방향 없음)
```

`{ global: true }` 리스너는 필터를 우회합니다. 정말 전역 관찰(텔레메트리, 로깅)에만
쓰십시오. 전역 리스너는 모든 에이전트의 이벤트를 받으므로, per-agent 상태를 만들 때는
반드시 payload의 `agent`를 키로 쓰십시오.

---

## 8. 통신 패턴 카탈로그

아래는 "이런 일을 하고 싶다"에서 출발하는 레시피입니다. 모든 예제는 호스트 플러그인의
`apply(ctx)` 안 또는 `agent.ctx` 안에서 실행됩니다.

### 8.1 다음 스텝에 컨텍스트 주입

```ts
export const inject = ['agents']

export function apply(ctx: Context) {
  ctx.on('agent/created', ({ agent }) => {
    // 첫 프롬프트 조립 전에 실행된다
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: '<workspace-rules>...</workspace-rules>' }],
      source: { kind: 'my-plugin', task: 'workspace-rules' },
    }))
  })
}
```

- `inject`는 wake하지 않습니다. idle이면 다음 followup/steer까지 pending입니다.
- 진행 중이면 **가장 가까운 다음 스텝 경계**에서 claim됩니다.
- 이미 pre-step이 배치를 claim한 요청에는 늦을 수 있습니다.

### 8.2 스텝 거부 또는 메시지 치환

```ts
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()
  if (decision.kind === 'reject') return decision

  // wrapping: startsRequestSeries 등 기존 선언을 반드시 보존
  return {
    ...decision,
    messages: [...decision.messages, extraContext],
  }
})
```

```text
next() ──► { kind:'enter', messages:[...], startsRequestSeries? }
   │
   ├─ 그대로 반환        = 승인
   ├─ messages 교체      = 치환 (id/source 보존)
   └─ { kind:'reject' }  = 스텝 거부, 턴은 스텝 없이 종료
```

`startsRequestSeries`를 잃으면 요청 헤더 시리즈가 깨집니다. 반드시 spread로 보존하십시오.

### 8.3 툴 호출 가로채기

```ts
ctx.on('tools/pre-execute', async (exec, next) => {
  if (exec.name !== 'bash') return next()

  if (isDangerous(exec.arguments)) {
    return { kind: 'deny', reason: 'blocked by my-plugin policy' }
  }
  if (needsUserApproval(exec.arguments)) {
    return { kind: 'ask', reason: 'my-plugin: confirm bash' }
  }
  return next()
})
```

- `ask`는 `ctx.approval`이 없거나 응답할 수 없으면 **거부**로 귀결됩니다.
- 비동기 게이트는 반드시 `exec.signal`을 관찰하십시오.
- 인자를 바꾸고 싶다면 여기가 아니라 툴 정의/프로바이더에서 처리하십시오.

### 8.4 결과 후처리

```ts
ctx.on('tools/post-execute', async (exec, result, next) => {
  const decision = await next()
  if (decision.kind !== 'accept') return decision

  if (shouldRedact(exec.name, decision.content)) {
    return { kind: 'accept', content: redact(decision.content) }
  }
  return decision
})
```

- `block`은 교정 피드백을 **에러 결과**로 바꿉니다.
- `additionalContexts`는 다음 요청에 `user/message`로 기록됩니다.
- `tools/result`에서는 아무것도 바꿀 수 없습니다(동결된 관찰).

### 8.5 새 턴 vs steer vs inject

```text
지금 하고 싶은 일                          선택
─────────────────────────────────────────────────────────────
독립적인 새 작업을 시키고 싶다             followup()
진행 중인 작업의 방향을 바꾸고 싶다         steer()
배경 정보만 넣고 깨우고 싶지 않다           inject()
정책상 스스로 판단하게 두고 싶다            pre-step에서 메시지 추가
턴을 더 이어 가게 하고 싶다                turn-stopping에서 steer
```

```ts
// 새 턴
agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'Run the test suite.' }],
  source: { kind: 'my-plugin', task: 'tests' },
}))

// 진행 중 턴의 다음 스텝
agent.steer(createUserMessage({
  content: [{ type: 'text', text: 'Focus on the failing test only.' }],
  source: { kind: 'my-plugin', task: 'narrow' },
}))
```

`steer`는 idle 드라이버를 깨워 새 턴을 시작합니다. `inject`는 깨우지 않습니다. 이 차이가
"왜 내 컨텍스트가 반영되지 않았나"의 90%입니다.

### 8.6 턴을 붙잡기

```ts
ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
  if (!hasUnresolvedWork(agent)) return
  agent.steer(createUserMessage({
    content: [{ type: 'text', text: 'Finish the remaining checklist items.' }],
    source: { kind: 'my-plugin', task: 'continue' },
  }))
})
```

- `serial` 모드입니다. async 리스너는 순서대로 await됩니다.
- **데이터가 결정합니다.** 리스너 순서로 결과를 뒤집을 수 없습니다. steer가 있으면
  기계가 inbox를 다시 읽고 스텝을 더 돌립니다.
- 툴 루프를 조기 종료하는 반대 방향은 `concludesTurn: true`입니다.

### 8.7 실패한 요청 재시도

```ts
ctx.on('agent/request-error', async (payload, next) => {
  if (!isTransient(payload.failure)) return next()
  if (!(await shouldRetry(payload))) return next()
  return { kind: 'retry' }
})
```

`next()`를 부르면 기본 정책에 위임합니다. `{ kind:'retry' }`는 재시도를 **소유**합니다.
기본값 `undefined`는 실패를 종결로 만듭니다.

### 8.8 서브에이전트 / 오케스트레이션

```ts
const handle = await ctx.agents.create({
  sessionId: newSessionId(),
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
  setup: (agentCtx, child) => {
    agentCtx.tools.register(childOnlyTool)
    agentCtx.on('agent/turn-stopping', () => { /* child 전용 정책 */ })
  },
})

await handle.agent.followup(taskMessage)
await handle.agent.whenIdle()
const summary = readFinalAssistantText(handle.agent.session)
await handle.dispose()
```

- `setup`은 **구성 전용**입니다. 여기서 에이전트를 구동하지 마십시오. 구동은
  `create()`가 resolve된 뒤에 하십시오.
- 부모-자식 관계는 `AgentRegistry`가 아니라 subagent 서비스가 소유합니다. 런타임 트리
  멤버십이 필요하면 `@deepseek-ai/dsh-subagent`를 쓰십시오.
- 자식의 실패를 부모의 실패로 바꾸지 마십시오. 각자의 세션 로그가 권위입니다.

### 8.9 UI로 라이브 상태 보내기

호스트에서 만든 라이브 이벤트를 브라우저로 보내려면 전송 계층을 거쳐야 합니다.

```text
agent/*  [L]  ──►  server / connection  ──►  SSE/JSON  ──►  client module
                                                              │
                                                              ▼
                                                        ctx.slots / store
```

브라우저 플러그인은 `session/event`의 durable 기록과 `agent/assistant-stream` 같은 라이브
프레임을 구분해서 다뤄야 합니다. 스트리밍 chunk를 durable로 착각하면 새로고침 후 중복
렌더링이 생깁니다.

### 8.10 durable 이벤트로 트랜스크립트 재구성

```ts
ctx.on('session/event', (session, event) => {
  switch (event.type) {
    case 'turn/start': /* ... */ break
    case 'tool/call':  /* ... */ break
    case 'tool/result':/* ... */ break
    case 'assistant/message': /* ... */ break
  }
})
```

- 재생/포크/텔레메트리는 이 평면만 봅니다.
- 순서는 `seq` 기준입니다. 라이브 도착 순서와 다를 수 있습니다.
- 새 모델 가시 데이터를 추가하려면 **여기에 남는 이벤트**를 설계하십시오.

---

## 9. 불변식과 실패 모드

| 불변식 | 위반 시 증상 | 대응 |
| --- | --- | --- |
| 모든 등록은 effect여야 한다 | unload 후에도 리스너/툴이 남음, 재시작 시 중복 | `ctx.effect`/반환 disposer 사용 |
| `apply` 밖 비동기 누수 금지 | unhandled rejection으로 프로세스 종료 | `ctx.effect`, `ctx.jobs`로 소유 |
| waterfall은 `next()`를 호출해야 한다 | 파이프라인 조기 종료(의도된 게이트) | 정말 차단할 때만 생략 |
| durable 없이는 모델 가시 입력 없음 | 재생/포크에서 컨텍스트 소실 | 세션 이벤트 + projection |
| `tools/pre-execute`에서 인자 재작성 금지 | 로그/UI/실행 불일치 | 툴 정의 단계에서 처리 |
| guard는 거부만 가능 | 순서 조작으로 권한 복구 | 보안 규칙은 guard로 |
| 스코프 등록은 dispose 후 거부 | 등록 후 즉시 사라짐/예외 | `agent/created`에서만 등록 |
| `agent.ctx`는 권한 경계가 아니다 | 서비스 해석 능력까지 위임됨 | 신뢰 경계로 쓰지 않음 |
| initiator는 프로세스 로컬 | 재시작/큐에서 귀속 소실 | 명시적 identity 전달 |
| `agent/created` 리스너 실패는 생성을 거부 | 에이전트 생성 실패 | 실패를 격리하거나 재시도 |
| cancel 후 입력은 사라질 수 있다 | "왜 메시지가 없지?" | `keepInbox` 또는 재전송 |

추가로 기억할 실패 모드:

- **`agent/pre-step`에서 예외를 던지면** 스텝이 실패합니다. 거부는 예외가 아니라
  `{ kind:'reject' }`로 표현하십시오.
- **`agent/turn-stopping`에서 `whenIdle()`을 await하면** 자기 자신을 기다려 교착됩니다.
- **`agent/created` 안에서 `whenIdle()`을 await하지 마십시오.** 생성 완료 전입니다.
- **dispose 중에는 `agent/ctx` 등록이 거부**됩니다. 정리 중 새 작업을 만들지 마십시오.
- **`tools/post-execute`에서 `next()` 결과를 무시하고 새 결과를 만들면** 정규화/불변식이
  우회됩니다. 반드시 `accept` 형태로 반환하십시오.

---

## 10. 디버깅 순서

1. **구성이 보이는가**

   ```sh
   dsh --profile web --dump-config
   ```

   `# == <package>` 줄이 보이지 않으면 플러그인이 레이어에 없는 것입니다(설치 ≠ 활성화).

2. **fiber가 ACTIVE인가**

   서비스가 `PENDING`에 머물면 `inject`한 서비스가 없습니다. 철자와 제공자 로드를 확인하십시오.

3. **이벤트가 도달하는가**

   전역 리스너로 먼저 받아 보고, 그다음 `agent.ctx`로 좁히십시오. 스코프 필터 때문에
   안 오는 경우가 많습니다.

4. **durable에 남았는가**

   `session/event`를 찍어 `turn/start → user/message → assistant/message → tool/call →
   tool/result → turn/end` 순서를 확인하십시오.

5. **모델이 실제로 본 것인가**

   라이브 이벤트만 보고 판단하지 마십시오. 모델 히스토리는 로그에서 유도됩니다.

6. **unload가 깨끗한가**

   플러그인을 끄고 다시 켰을 때 리스너/툴이 중복되지 않는지 확인하십시오. 중복되면
   effect 밖 등록이 있습니다.

---

## 11. 더 읽을 것

하네스 저장소의 1차 자료:

| 문서 | 이유 |
| --- | --- |
| `docs/architecture.md` | 턴 흐름, 이벤트 3도메인, 확장점 지도 |
| `docs/subsystems/core.md` | `Agent`/`AgentRegistry`/`agent/*` 정확한 시그니처 |
| `docs/subsystems/scope.md` | `ScopeKey`, `Scoped<T>`, 가시성/수명 규칙 |
| `docs/subsystems/tools.md` | 툴 등록, 파이프라인, 실행기 |
| `docs/subsystems/session.md` | durable 로그, projection, 포크 |
| `docs/agent-lifecycle.md` | 턴/스텝 시퀀스 다이어그램 |
| `docs/tool-execution-pipeline.md` | 툴 파이프라인 전체 그래프 |
| `docs/event-producer-consumer.md` | 이벤트별 생산자/소비자 매트릭스 |
| `packages/core/agent/README.md` | `Agent` 사용 계약과 inbox 의미 |
| `packages/core/agent-loop/README.md` | 드라이버 구현, 생성/해체 순서 |
| `packages/core/scope/README.md` | 스코프 라이브러리 API와 한계 |

이 문서를 읽고 나면 [IMPLEMENTATION-GUIDE.md](./IMPLEMENTATION-GUIDE.md)의 레시피가
"왜 그렇게 쓰는지" 이해될 것입니다. 구조적 배경은 [ARCHITECTURE.md](./ARCHITECTURE.md)를
참고하십시오.
