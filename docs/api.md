# Mobi HTTP API v1 — A1/A2 + A4/A5/A12 local implementation

이 문서는 `.omc/plans/mobi-implementation-plan.md`의 /v1 표를 기준으로 한다. 등록·인증·AI 접근 제한·일일 상한, Google 페어링/OAuth·연결 해제, Calendar 오늘 일정이 동작한다. 로컬 테스트는 Google HTTP를 전부 모의 처리하며 실제 계정·배포는 사용하지 않는다. STT/TTS/LLM 음성 경로는 아래 추가 계약을 사용한다. Slack·행동 실행은 검사를 통과하면 **501**을 반환한다.

응답 계약의 단일 원본은 [`server/src/schemas.ts`](../server/src/schemas.ts)다. 기존 `responseSchemas`와 등록 201·오류·요청 형태는 보존하고 새 성공 200·오류 410/502는 `additionalResponseSchemas`에 추가한다. 서버와 로컬 Worker/SQLite Durable Object 테스트가 실제 JSON 응답을 검증한다.

## 공통 규칙

- 로컬 주소: `http://localhost:8787`. Vitest는 Google과 AI를 로컬 mock으로 대체한다. `wrangler dev`의 AI binding은 실제 계정의 모델을 호출하므로 실측용 예산을 적용한다.
- 본문이 있는 POST는 `Content-Type: application/json`이 필수다. 빈 객체도 `{}`를 보낸다. 알 수 없는 필드는 400이다.
- JSON 전체는 UTF-8 기준 512 KiB 이하. 넘으면 413. 오디오 base64는 앱이 만들며 서버는 bounded decode로 WAV header와 발화 에너지를 검사한다.
- API 응답은 JSON이며 `Cache-Control: no-store`. 공개 `/pair/{code}`와 Google callback은 보안 헤더를 가진 HTML이다. 앱의 일정/노크 캐시는 `/v1/today` 성공 데이터에 대해 앱이 별도로 관리한다.
- 인증: 등록 시 받은 `deviceToken`을 `Authorization: Bearer <deviceToken>`으로 보낸다. 별도의 deviceId 헤더는 없다. 토큰은 `<UUID>.<256-bit random hex>`이며 기기 ID만으로는 인증할 수 없다.
- 토큰 원문은 등록 응답에만 포함한다. 서버에는 토큰 전체의 SHA-256 해시만 저장한다. 앱은 Android Keystore 등 안전한 저장소에 보관한다. 요청 본문, 토큰, IP, 음성을 로그에 남기지 않는다.
- 코드: `[A-Za-z0-9_-]{6,64}`. 행동 ID: `[A-Za-z0-9_-]{1,64}`. provider: `google` 또는 `slack`.

## 경로·요청·현재 응답

| 메서드·경로 | 인증 | JSON 요청 | 현재 응답 |
|---|---|---|---|
| `POST /v1/devices` | 공개 | `{}` | 201 등록 / 400 / 413 / 429(IP 제한) |
| `POST /v1/pairing` | 기기 | `{}` | 200 `{code,pairingUrl,expiresAt}` |
| `GET /v1/pairing/{code}` | 기기 | 없음 | 소유자만 200 `{status,expiresAt}`, 404/410 |
| `GET /pair/{code}` | 공개 | 없음 | 200 HTML·기본 브라우저 안내, 404/410 HTML |
| `GET /oauth/{provider}/callback` | 공개 | 없음 | Google: 200/400/410/500/502 HTML. Slack: 501 JSON |
| `DELETE /v1/connections/{provider}` | 기기 | 없음 | Google: 200 `{provider,connected,revocation}`. Slack: 501 |
| `GET /v1/today` | 기기 | 없음 | Google 연결 시 200 `{date,timeZone,events,knock}`, 미연결/갱신 불능 403, provider 일시 오류 502 |
| `POST /v1/briefings` | 기기 + 페어링 | 아래 브리핑 요청 | 200 / 429 / 502 |
| `POST /v1/confirm` | 기기 + 페어링 | 아래 확인 요청 | 200 / 400 / 429 / 502. STT 전용, LLM 없음 |
| `POST /v1/turns` | 기기 + 페어링 | 아래 턴 요청 | 200 / 429 / 502 |
| `POST /v1/actions/{id}/approve` | 기기 | `{"contentHash":"<64 lowercase hex>"}` | 501(P1) |
| `POST /v1/actions/{id}/cancel` | 기기 | `{}` | 501(P1) |

보호 경로는 공통으로 인증 누락·형식 오류·미등록·위조 토큰에 401을 반환한다. AI 세 경로는 미페어링 기기에 403을 반환한다. 본문이 필요한 경로는 본문 검증 실패에 400/413을 반환한다. 없는 경로·허용되지 않은 provider/경로 매개변수는 404, 존재하는 경로의 다른 메서드는 405와 `Allow` 헤더를 반환한다. 예상하지 못한 내부 실패는 상세 정보를 노출하지 않는 500이다.

검사 순서: 경로/메서드 → 기기 인증 → AI 페어링 → JSON schema 검증 → 상한 → WAV 의미 검사/처리부(Phase 2 미구현 경로는 501). 따라서 AI 미페어링 요청은 본문이 잘못되어도 403이다. 인증·페어링·본문 검증 실패와 비AI 요청은 AI 상한을 차감하지 않는다.

### 등록

```http
POST /v1/devices
Content-Type: application/json

{}
```

201 응답 (`deviceId`와 `deviceToken`은 아래 형식의 실제 무작위 값):

```json
{
  "deviceId": "<UUID>",
  "deviceToken": "<same UUID>.<64 lowercase hex>"
}
```

등록 데이터와 사용량은 기기당 `DeviceAgent` DO에 저장한다. 기기 등록은 IP당 UTC 하루 5회, 전체 하루 100회다. IP는 Cloudflare가 제공하는 `CF-Connecting-IP`만 사용하고, `X-Forwarded-For`나 JSON 값으로 변경할 수 없다. 로컬에서 이 헤더가 없으면 모든 요청은 하나의 `local-unknown` 버킷을 공유한다. 헤더가 있는 로컬 요청은 테스트 목적으로 IP를 지정할 수 있으므로 인터넷에 노출하는 프록시는 이 헤더를 신뢰 가능한 값으로 덮어써야 한다. 같은 공인 IP의 사용자도 한도를 공유하며 이는 공모전 기간의 임시 제한이다.

원본 IP는 저장하지 않고 고정 `admission` DO 안의 해시 버킷 키로 사용한다. 실제 발급된 기기 ID와 토큰 해시를 이 객체에서 먼저 확인한 뒤 기기 DO를 조회하므로 임의 ID는 객체를 만들지 않는다. 이 registry 도입 전에 발급된 기기는 새 등록·Google 연결이 필요하다. 등록 제한 통과 후 내부 저장이 실패하면 등록 슬롯은 복구하지 않는다. POST 재시도는 새 기기 등록으로 계산한다.

### 브리핑·음성 요청

브리핑:

```json
{"tripId":"trip-1","remainingSeconds":180}
```

`tripId`: 1~64자. `remainingSeconds`: 0 이상의 정수(초), 경로가 없으면 `null`을 명시한다. 필드를 생략할 수 없다. A7에서 300초 미만은 한 줄, 300~899초는 요약, 900초 이상은 전체, `null`은 요약으로 처리한다.

확인:

```json
{"audio":{"data":"AAAA","mimeType":"audio/wav"}}
```

질문 턴:

```json
{"tripId":"trip-1","audio":{"data":"AAAA","mimeType":"audio/wav"}}
```

`audio.data`: 표준 base64, 4~360,000자, data URL 접두사 없음. 패딩이 필요한 길이는 `=` 패딩 필수. `mimeType`: `audio/wav`, `audio/webm`, `audio/mp4`. 앱은 최대 8초의 발화만 보낸다. 초기 A1의 문법 검증은 유지하며, 실제 WAV 컨테이너/길이/에너지 검사는 아래 음성 구현 계약을 따른다. 예시 `AAAA`는 문법 예시이며 실제 음성 파일은 아니다. 업로드된 오디오는 영구 저장하지 않는다.

`/v1/turns` 성공 응답은 구현 계획의 `{turnId, transcript, sentences:[{text, audio}]}` 형태를 따른다. v1 답변은 1문장·60토큰 이하이며, 성공 스키마/오디오 응답 형식은 아래 동결된 음성 추가 계약을 따른다.

## 오류 계약

429를 제외한 오류:

```json
{
  "error": {"code":"PAIRING_REQUIRED","message":"Pair this device before using AI."},
  "fallback":"cached_knock_or_silence"
}
```

429:

```json
{
  "error": {
    "code":"DEVICE_DAILY_LIMIT",
    "message":"Daily limit reached. Use cached knock audio or stay silent; never speak this error."
  },
  "fallback":"cached_knock_or_silence",
  "retryAfterSeconds":3600
}
```

`message`는 진단용이며 **낭독하지 않는다**. 앱은 `fallback`에 따라 저장된 노크 음성이 있으면 정보만 전달하는 캐시 음성을 사용하고, 캐시가 없으면 묵음으로 처리한다. 서버가 재생 여부를 결정하지 않는다. 429는 다음 UTC 자정까지의 양의 정수 초를 본문과 `Retry-After` 헤더에 동일하게 제공한다. 요청을 즉시 반복하지 않는다.

| 상태 | `error.code` |
|---|---|
| 400 | `BAD_REQUEST` |
| 401 | `UNAUTHORIZED` |
| 403 | `PAIRING_REQUIRED` |
| 404 | `NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 410 | `NOT_FOUND` (만료/소진된 pairing 코드) |
| 413 | `PAYLOAD_TOO_LARGE` |
| 429 | `REGISTRATION_LIMIT`, `DEVICE_DAILY_LIMIT`, `GLOBAL_DAILY_LIMIT` |
| 500 | `INTERNAL_ERROR` |
| 501 | `NOT_IMPLEMENTED` |
| 502 | `INTERNAL_ERROR` (Google/AI 처리 오류·잘못된 provider 데이터·음성 deadline) |

HTML 오류는 요청 정보나 provider 원문을 반영하지 않는 안내문이다. JSON 오류의 `message`·`fallback` 계약은 기존과 같다. OAuth/Calendar 오류를 음성으로 읽지 않는다.

## Google 페어링과 연결 해제

등록한 기기로 `POST /v1/pairing`에 `{}`를 보내면 32바이트 무작위 base64url 코드(43자), HTTPS `pairingUrl`, UTC RFC3339 `expiresAt`을 받는다. 앱이 **pairingUrl 자체를 QR에 인코딩**한다. 서버는 QR 이미지나 외부 QR 서비스를 사용하지 않는다. URL에 deviceToken·계정 정보는 없다. 유효기간은 발급부터 정확히 5분이며 방문/조회로 연장되지 않는다.

휴대폰 `/pair/{code}` 페이지는 Chrome/Safari 등 기본 브라우저 사용을 안내한다. 알려진 인앱 브라우저에서는 Google 로그인 링크를 제공하지 않고 기본 브라우저에서 열 주소를 보여준다. UA 감지는 안내를 위한 보조 수단이다. 실제 로그인은 Google의 secure-browser 정책을 충족하는 외부 브라우저에서 진행해야 한다.

Google authorization은 `access_type=offline&prompt=consent`와 random state를 사용한다. state/cookie의 해시를 코드 DO에 저장하고 Secure·HttpOnly·SameSite=Lax cookie로 callback을 브라우저에 결합한다. callback은 state/cookie/만료를 검증한 뒤 원자적으로 코드를 소진하므로 중복 callback은 **410**, 토큰 교환은 한 번이다. 실패한 교환은 새 코드를 발급받아 재시도한다. 코드 해시·만료시각은 만료 후 최대 하루 더 보존한다.

페어링 발급은 기기당 UTC 하루 5회다. 발급 코드 해시를 고정 admission registry에서 확인한 후에만 코드별 DO를 조회한다. 발급 5분 뒤 알람으로 해당 DO의 OAuth 상태·쿠키 해시·기기 참조를 삭제한다. 410 응답을 위한 코드 해시·만료시각만 최대 하루 더 유지하고 알람으로 제거한다.

소유자 polling의 status는 `pending`, `processing`, `paired`, `failed`다. 소유자가 아닌 기기/미존재 코드는 404, 미사용 만료나 해제로 무효화된 진행 중 코드는 410이다. 발급 5분 이내에 완료 후 소유자의 상태 관측은 코드 재사용이 아니므로 paired 조회가 가능하고, 공개 page/callback을 다시 사용하는 것은 410이다. DO 간 완료 표시가 실패해도 기기 DO의 committed attempt로 polling을 복구한다.

동의 scope:

```text
https://www.googleapis.com/auth/calendar.events.readonly
https://www.googleapis.com/auth/calendar.calendars.readonly
```

Calendar metadata scope는 primary calendar 시간대 조회에 필요하다. 현재 구현은 Gmail scope를 요청하지 않으며 Gmail API를 호출하지 않는다. [Calendar 권한](https://developers.google.com/workspace/calendar/api/auth).

Google access/refresh token·만료·scope는 기기 DO 안에서 AES-256-GCM으로 암호화해 저장한다. 새 IV와 기기/provider AAD를 사용하며 키·평문 토큰은 저장·기록하지 않는다. 키는 `TOKEN_ENCRYPTION_KEY`, OAuth 설정은 `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, 외부 URL 원본은 `PUBLIC_ORIGIN` Env/Worker secret에서만 받는다. 실제 값은 소스/vars/문서/로그에 넣지 않는다. PUBLIC_ORIGIN은 path/query/fragment/userinfo 없는 HTTPS origin이며 요청 Host로 redirect URI를 바꾸지 않는다. 키가 바뀌면 기존 암호문을 복호화할 수 없으며 자동 평문 fallback/키 migration은 없다.

`DELETE /v1/connections/google`은 로컬 토큰 삭제·paired=false·연결 epoch 증가를 먼저 완료한 뒤 Google revoke를 시도한다.

```json
{"provider":"google","connected":false,"revocation":"revoked"}
```

revoke가 실패해도 로컬 해제를 되돌리지 않고 `revocation:"failed"`로 알린다. 이미 해제되어 있으면 `"not_needed"`다. 늦은 callback/refresh는 epoch 검사로 토큰을 복원할 수 없다. Google revoke는 동일 프로젝트의 더 넓은 grant에도 영향을 줄 수 있으며 새 연결에는 새 동의가 필요하다. [Google OAuth/refresh/revoke](https://developers.google.com/identity/protocols/oauth2/web-server).

테스트 모드 Google refresh token은 만료될 수 있다(R7). 갱신 불능은 연결을 제거하고 403 PAIRING_REQUIRED를 반환한다. 녹화/PT 전 6일 이내 재연결을 확인한다. 네트워크/429/5xx는 연결을 보존하고 502와 기존 fallback을 반환한다. 각 Google 작업은 공유하는 6초 deadline 안에서 실행한다.

## 오늘 일정과 시간대

Calendar GET은 AI 한도와 별도로 기기당 UTC 하루 120회, 전체 하루 1,000회이며, 기기 DO RPC 전에 원자적으로 차감한다. 한도를 넘으면 기존 429 스키마와 `DEVICE_DAILY_LIMIT`/`GLOBAL_DAILY_LIMIT` 코드를 사용한다. 실패·캐시 적중 요청도 차감한다. 기기 DO는 성공한 조회를 30초 캐시하고 진행 중인 조회를 공유한다. 짧은 폴링·재연결 중복을 줄이되 이동 중 일정 변경 반영을 30초 이내로 제한하며, calendar-local 날짜나 연결 epoch가 달라지면 재사용하지 않는다.

아래 첫 예시는 기존 Calendar 필드만 표시한 부분 예시다. 전체 성공 응답에는 추가 계약의 `knock`도 항상 포함한다.

`GET /v1/today`는 primary calendar의 IANA timeZone을 조회한 뒤 해당 시간대의 오늘 시작부터 다음 날 시작까지를 계산한다. 서버/기기의 UTC 날짜나 24시간 고정 더하기를 사용하지 않는다. DST로 23/25시간인 날과 자정 offset 전환도 처리한다. 날짜 오류나 provider 실패는 502로 처리한다. 아래 명시된 크기·개수 한도에 도달하면 검증을 마친 일정만 순서대로 반환하며, 크기 초과로 첫 페이지도 확보하지 못하면 빈 일정으로 오인하지 않도록 502를 반환한다.

```json
{
  "date":"2026-10-24",
  "timeZone":"Asia/Seoul",
  "events":[{
    "id":"event-1",
    "title":"회의",
    "start":{"dateTime":"2026-10-24T09:05:00+09:00"},
    "end":{"dateTime":"2026-10-24T10:00:00+09:00"}
  }]
}
```

종일 일정은 start/end에 `{"date":"YYYY-MM-DD"}`를 사용하며 종료일은 exclusive다. timed 일정의 offset/instant와 원본 제목을 보존한다. 없는 제목은 `제목 없는 일정`, 장소는 있을 때만 location이다. description/attendees/organizer·계정 이메일은 응답하지 않는다. 시간순/id순으로 정렬하고 취소 일정을 제외하며 반복 일정과 모든 페이지를 수집한다. 포함 조건은 `end > 오늘 시작 && start < 내일 시작`으로 전날부터 이어지는 일정을 포함한다. [Calendar 필터 규칙](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

빈 날은 `events:[]`다. A7 노크 음성 bundle은 아래 추가 계약의 `knock` 필드다. today/연결 요청은 AI를 호출하거나 AI quota를 차감하지 않는다.

Google provider JSON 응답은 스트림에서 본문을 최대 1 MiB까지만 읽는다. 하루 응답은 최대 5개 일정 페이지와 provider 일정 항목 200개, continuation token 1,024자, id 256자, 제목/장소 각 200자로 제한한다. 한도를 넘으면 이미 처리한 일정이 있을 때 시간/id 순서로 정렬한 앞부분을 반환하고, 유효한 일정이 하나도 없으면 기존 502 오류 계약을 사용해 빈 날로 오인되지 않게 한다. briefing 및 TTS 입력은 1,200자로 자르고 끝에 말줄임표를 붙인다. 기존 JSON 필드 구조는 유지된다.

## TTS 입력 정리

`server/src/tts.ts`의 순수 함수 `sanitizeTtsText`는 TTS adapter가 합성 직전에 호출하는 경계다. 마크업·URL·emoji/ZWJ·제어 문자를 정리하고 시각·숫자·단위를 한국어로 바꾼다. 카드용 일정 원문은 변경하지 않는다. 예: `09:05` → `아홉 시 오 분`, `3개` → `세 개`, `12,000원` → `일만 이천 원`. 링크는 label만 남긴다. 20문장 고정 fixture와 빈 값·emoji/keycap·멱등성·추가 숫자 사례를 검증한다. 실제 음성 합성과 엔진 청취 평가는 별도 S3/A8 범위다.

## 일일 상한과 저장 구조

- **상한 카운터의 날짜**는 UTC 자정 = 한국 시간 09:00에 초기화된다. Calendar 오늘 날짜는 위의 calendar timeZone을 따른다.
- `DEVICE_DAILY_CAP=20`, `GLOBAL_DAILY_CAP=250`이 `server/wrangler.jsonc`의 기본값이다. 음이 아닌 정수 문자열만 허용하며 0은 해당 AI 요청을 모두 차단한다. 잘못된 설정은 500으로 차단한다.
- 이는 **유효한 페어링 AI 요청 횟수**의 상한이다. neuron 사용량 계측이 아니며 무료 할당을 보장하지 않는다. 계획의 약 250~400턴/일 추정에서 보수적으로 250회를 선택했다. 브리핑·확인·턴이 같은 상한을 공유한다.
- 실제 AI 호출은 별도 `quota:neurons` UTC 일별 장부에서 보수적인 예상 neuron을 원자적으로 예약한다(10,000/일). 기본 호출과 헤지 모두 시작 전에 예약하며 실패·패배한 호출도 예약을 유지한다. 다른 Worker의 사용량은 포함하지 않으므로 계정 전체 무료 할당을 보장하는 계측값은 아니다. 예약 거부 시 추가 추론을 시작하지 않는다.
- 검사를 통과한 AI 요청은 무음으로 STT를 생략하거나 처리에 실패해도 **1회를 차감**한다. 등록·페어링·OAuth·today·연결 해제·승인/취소 요청은 AI 상한을 차감하지 않는다.
- 기기 상한부터 차감한 뒤 전체 상한을 확인한다. 전체 상한에서 거절되거나 이후 내부 오류가 나면 이미 차감한 기기 슬롯을 돌려주지 않는다. 두 DO를 아우르는 트랜잭션은 사용하지 않으며 보수적인 과소 허용만 발생한다.
- `DeviceAgent`: 기기 인증 해시·paired·기기 일일 카운터, 암호화 Google 연결, 연결 epoch/완료 attempt. 신규 기기는 미페어링이며 공개 임의 상태 변경 API는 없다.
- `Pairing`: `registration:<IP digest>`는 IP별 등록 카운터, `quota:global`은 전체 AI 카운터, `pairing:<code>`는 일회용 코드·state/cookie 해시·tombstone을 보관한다.
- 음성 단계별 헤지는 최대 1회다. STT는 확인 경로에서 1,400ms, 턴 경로에서 1,000ms 뒤 Whisper 대체 모델, LLM/TTS는 각각 650/600ms 뒤 같은 입력의 두 번째 호출을 시작한다. 남은 시간이 단계 중앙값과 해당 LLM/TTS 진입 시간 한도를 모두 수용할 때만 시작하며, 검증된 첫 결과를 사용한다. 요청 deadline은 기존 4,800ms다. 대체 STT에도 환각 억제와 SEND/CHANGE 정확 일치 규칙이 동일하게 적용된다.
- 각 카운터는 한 행을 유지하고 날짜가 앞으로 바뀌면 교체한다. 이전 날짜의 지연 요청은 거절해 카운터를 되돌리지 않는다. SQLite의 단일 조건부 UPSERT로 동시 요청의 상한 초과 승인을 막는다. DO 상태는 재시작 후에도 보존되고 D1은 사용하지 않는다.
- 한 Worker 구성의 전체 상한이다. 다른 Worker 배포나 다른 앱과 공유하는 Cloudflare 계정의 AI 사용량은 합산하지 않는다. 개발/제출 배포의 계정 할당 공유 문제는 이후 운영 절차로 관리해야 한다.

## 로컬 실행과 검증

Node 22.23.2 / npm 10.9.8 기준. 작업 디렉터리를 `server/`로 둔다.

```sh
npm ci --cache .npm-cache --no-audit --no-fund
export npm_config_cache="$PWD/.npm-cache"
export TMPDIR="$PWD/.wrangler/tmp"
export TZ=UTC
mkdir -p "$TMPDIR"
npx tsc --noEmit
npx vitest run
npx --no-install wrangler deploy --dry-run --outdir .wrangler/dry-run
npm run dev
```

최초 설치만 npm ci를 실행한다. dry-run은 로컬 bundle 검사이며 업로드/배포하지 않는다. OAuth 실제 client는 아직 없고 wrangler의 PUBLIC_ORIGIN도 placeholder다. Google client/secret/키의 가짜 값은 vitest config에서만 주입하며 Google outbound HTTP는 fetchMock으로 대체·실통신 차단한다. 별도 secret 파일이나 실제 Google 동의를 로컬 테스트에 요구하지 않는다. `npm run dev`에서 secret 없는 연결 시도는 안전한 설정 오류로 끝나며 mock OAuth 성공은 vitest suite에서 확인한다.

테스트는 `@cloudflare/vitest-pool-workers` + Vitest 3의 호환 버전을 고정한다. 이 패키지는 현재 `@cloudflare/vitest-plugin`으로 이름이 변경되었으나 작업 요구에 따라 기존 패키지를 사용한다. 로컬 SQLite DO에서 기존 등록·인증·쿼터 회귀와 pairing single-use·token storage·race·Calendar 시간대·응답 스키마를 검증한다. 기존 AI quota fixture만 paired를 직접 준비하며 새 A4/A5 통합 테스트는 모의 Google OAuth를 실제로 통과한다. HTTP 우회 경로는 없다.

10ms CPU 예산과 실제 크기 음성 요청의 운영 성능은 S7의 Cloudflare 측정 항목이다. 로컬 타입체크/테스트로 운영 CPU·응답 지연을 확인했다고 주장하지 않는다.

구성 근거: [Cloudflare SQLite DO 저장 API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)의 SQLite 저장 방식과 [Cloudflare Workers Vitest 가이드](https://developers.cloudflare.com/workers/testing/vitest-integration/)를 참고했다. 잠긴 테스트 풀 버전의 설정 API는 설치된 패키지의 타입 정의를 따른다.


## A7/A8/A11 voice contract additions (frozen)

### Common audio and error rules

입력 schema는 그대로다: `audio:{data:string,mimeType:'audio/wav'|'audio/webm'|'audio/mp4'}`. 표준 base64 4~360,000자, 필요한 `=` padding 포함, data URL 없음. JSON 전체 512 KiB 이하. 앱의 신규 구현은 **PCM signed 16-bit little-endian / 16,000 Hz / mono / WAV RIFF**만 전송한다. 녹음 최대 8초, PCM data 최대 256,000 bytes, 표준 44-byte header 파일은 최대 256,044 bytes(base64 341,392자). 기존 base64 상한으로 전체 decoded file은 최대 270,000 bytes다. 확장 WAV chunk는 이 총 크기 안에서만 허용한다.

서버는 `RIFF`/`WAVE`, RIFF 길이, `fmt ` PCM=1/channels=1/rate=16000/bits=16/blockAlign=2/byteRate=32000, `data` 존재/짝수 크기/1~128,000 samples, chunk 범위/odd padding을 확인한다. fmt/data 중복, truncation, NaN 유도 헤더는 400. 이 의미 검사는 기존 schema/쿼터 뒤에서 하므로 malformed container도 유효 JSON 요청으로 admission된 경우 1회 차감한다. schema/인증/페어링 실패는 기존대로 차감하지 않는다.

**Frozen MIME 호환:** WebM/MP4 enum을 제거하거나 요청 shape를 변경하지 않는다. v1에는 이 둘의 에너지 검사 가능한 decoder가 없으므로 schema/admission 이후 **502 INTERNAL_ERROR + 기존 fallback**으로 끝내고 AI 호출 0. WAV MIME에 압축 컨테이너를 붙이면 400. 이것은 지원 음성 경로를 PCM WAV로 명시하는 것이며, 기존 성공 구현(아직 501뿐임)을 제거하지 않는다. 알 수 없는 MIME은 기존대로 400. 무가드 STT로 우회하지 않는다.

출력 `audio`는 정확히 `{data:string,mimeType:'audio/wav'}`. `data`는 WAV 전체 바이트의 표준 base64이며 앱이 decode→파일/MediaPlayer로 재생한다. MIME을 upstream header로 추측하지 않고 RIFF 확인 후 설정한다. sample rate는 WAV header가 권위이며 MeloTTS의 실측 44.1kHz를 16kHz 입력과 혼동하지 않는다. 출력당 decoded WAV 상한 2 MiB(base64 최대 2,796,204자). 빈/잘못된/상한 초과 upstream 음성은 502, 부분 성공이나 가짜 audio 없음. JSON request 512 KiB 제한을 response에 적용하지 않는다.

실패는 기존 `{error:{code,message},fallback:'cached_knock_or_silence'}`. 처리 timeout/unsupported container/provider 실패/invalid LLM payload는 502 `INTERNAL_ERROR`, 상세 provider 내용 노출 없음. body 400/413, auth 401/403, caps 429 그대로. 오류 message를 합성하지 않는다. 기존 no-store/security headers 유지.

### GET /v1/today

요청 body 없음, 기존 Google 연결 및 `{date,timeZone,events}`의 의미 불변. 성공에 **`knock` 하나만 추가**한다. 기존 `todayResponseSchema`는 base 계약으로 남기고 확장 schema로 응답한다. 앱은 추가 필드를 허용하는 decoder를 사용해야 한다.

```json
{
  "date":"2026-10-24",
  "timeZone":"Asia/Seoul",
  "events":[],
  "knock":{
    "version":"knock-v1",
    "date":"2026-10-24",
    "timeZone":"Asia/Seoul",
    "eventCount":0,
    "online":{
      "text":"오늘 일정은 없어요.",
      "audio":{"data":"<base64 WAV>","mimeType":"audio/wav"},
      "sha256":"<64 lowercase hex of WAV bytes>"
    },
    "offline":{
      "text":"오늘 일정은 없어요.",
      "audio":{"data":"<same base64 WAV>","mimeType":"audio/wav"},
      "sha256":"<same 64 lowercase hex>"
    }
  }
}
```

- count=1 online: `오늘 일정이 한 개 있어요. 들을까요?`; offline: `오늘 일정이 한 개 있어요. 정차하면 카드로 보여드릴게요.`
- count≥2 online: `오늘 일정이 여러 개 있어요. 들을까요?`; offline: `오늘 일정이 여러 개 있어요. 정차하면 카드로 보여드릴게요.`
- count=0은 online/offline 공통 1개 WAV. 총 고유 텍스트/WAV **5개**. 숫자별 대형 오디오 사전 대신 범주형 고정 템플릿을 사용하고 정확한 개수는 `eventCount`로 제공한다. 일정 제목/계정 정보는 정적 asset에 넣지 않는다.
- `/today`의 기존 데이터 오류는 기존 상태로 실패하며 AI로 대체하지 않는다. 노크 조회/콜드 스타트/반복 조회에 `AI.run` 0, quota 0. 미연결에는 403이며 음성만 따로 공개 제공하지 않는다.
- 앱은 `version + sha256`로 파일을 갱신하고 `date + timeZone`으로 일정 유효성을 판단한다. 같은 calendar date의 마지막 온라인 bundle만 그날 오프라인에 사용한다. 날짜 불일치/없음은 묵음. 캐시된 offline 문장에는 질문이 없다. 서버 no-store는 앱의 명시적 로컬 파일 캐시를 막는 계약이 아니다.

### POST /v1/briefings

요청은 기존 그대로:

```json
{"tripId":"trip-1","remainingSeconds":180}
```

`tripId` 1~64자, `remainingSeconds`는 필수 nullable nonnegative integer. 앱의 Navi remainTime(초)을 변환 없이 넣는다. 구간은 `<300→short`, `300..899→summary`, `>=900→full`, `null→summary`. 3/10/30분은 **180/600/1800**, 경계 299/300/899/900 포함 테스트.

성공의 정확한 필드:

```json
{
  "briefingId":"<UUID>",
  "tripId":"trip-1",
  "bucket":"short",
  "text":"오늘 일정은 세 개예요.",
  "audio":{"data":"<base64 WAV>","mimeType":"audio/wav"}
}
```

- `bucket` enum `short|summary|full`, 나머지 필드 필수. UUID는 매 요청 생성하며 idempotency key가 아니다.
- Calendar는 기존 today 결과/시간대/정렬을 재사용한다. LLM 없이 템플릿 생성, 합성은 하나의 WAV로 한 번 호출한다. 남은 시간은 구간 선택에만 사용하며 경로/ETA가 없다고 임의 추정하지 않는다.
- `short`: `오늘 일정은 N개예요.` 한 문장(빈 날 `오늘 일정은 없어요.`).
- `summary`: count 한 문장 + 첫 일정의 시간/제목 한 문장. 빈 날은 한 문장, 일정이 있으면 정확히 두 문장.
- `full`: count 한 문장 + **모든** 일정 각각 한 문장. N개이면 N+1문장, 빈 날은 한 문장. 단일 TTS가 6초 total/출력 크기 안에 끝나지 않으면 전체 502, 잘린 전체 브리핑을 성공으로 반환하지 않는다. 긴 일정일의 이 한계는 실측 위험으로 남긴다.
- 각 일정 문장은 timed이면 calendar timeZone의 `HH:mm에 TITLE 일정이 있어요.`, all-day이면 `종일 TITLE 일정이 있어요.`. 제목 속 개행/문장 종결 기호는 공백으로 치환한 뒤 사용하여 fixture의 문장 수가 제목에 의해 늘지 않게 한다. TTS용 최종 text는 sanitizer 결과이고 카드용 events 원문은 변경하지 않는다.
- 앱은 노크 재생 시작과 동시에 POST하고 완성된 WAV를 보관한다. 수락 후 1초 재생 목표는 사전 fetch가 끝난 경우의 앱 지표이며 서버 응답시간 1초 보장으로 해석하지 않는다.

### POST /v1/confirm

요청 변경 없음:

```json
{"audio":{"data":"<base64 PCM16 16kHz mono WAV>","mimeType":"audio/wav"}}
```

성공의 정확한 필드:

```json
{
  "transcript":"보내.",
  "match":{"label":"보내","action":"SEND","mode":"exact"}
}
```

`transcript`는 hallucination guard 후 trim된 인식 원문이다. 안전하지 않은 인식은 `""`. `match.label`은 스파이크 REPLIES 20개 또는 `NONE`; `action`은 `LISTEN|NOT_NOW|SEND|CHANGE|CANCEL`; `mode`는 `exact|fuzzy-safe|none`. 거리/음성/LLM 결과/쓰기 승인 토큰을 넣지 않는다. 억제된 입력은 정확히 `{"transcript":"","match":{"label":"NONE","action":"NOT_NOW","mode":"none"}}`.

서버는 STT와 순수 closed-set matcher만 사용한다. Calendar/LLM/TTS 호출 0. match는 앱 사전을 위한 참고이며 앱이 현재 상태·부정 우선·승인 문맥을 최종 결정한다. `SEND`/`CHANGE` 자체는 실행 권한이 아니고 이 요청의 부수 효과는 quota뿐이다. `응/네`는 LISTEN, `보내지 마/바꾸지 마/취소`는 CANCEL.

### POST /v1/turns

요청 변경 없음:

```json
{"tripId":"trip-1","audio":{"data":"<base64 PCM16 16kHz mono WAV>","mimeType":"audio/wav"}}
```

성공의 정확한 필드:

```json
{
  "turnId":"<UUID>",
  "transcript":"오늘 일정 알려줘.",
  "sentences":[
    {"text":"오늘 일정은 세 개예요.","audio":{"data":"<base64 WAV>","mimeType":"audio/wav"}}
  ]
}
```

세 top-level 필드 모두 필수. `turnId`는 매 요청 UUID, `sentences` 길이 0..1. 정상 발화에 대한 음성 답변은 정확히 한 문장. 무음/저에너지/환각 억제는 `transcript:"",sentences:[]`로 200이며 후속 Calendar/LLM/TTS 호출 0. `proposal`은 P1 미구현이므로 필드를 내보내지 않는다. 단어 명령이 SEND여도 action 호출하지 않는다. 앱은 취소/새 턴 뒤 pending request의 결과를 자체 request handle/turnId로 폐기한다. 서버는 v1에서 trip history를 저장하지 않는다.


### Shared deadline and provider boundary

음성 세 POST 및 today는 서버 fetch 진입부터 4,800ms absolute deadline을 공유한다. 질문의 700ms 말 끝 감지·300ms 업로드·200ms 다운로드/재생을 포함한 전체 6초 상한을 위해 앱에도 deadline/취소 후 늦은 응답 폐기가 필요하다. 각 STT/Calendar(토큰 refresh 포함)/LLM/TTS가 새 6초를 받지 않는다. STT 결과가 없거나 최종 인증이 완료되지 않은 timeout은502로 반환한다. 이미 검증된 질문 전사가 있을 때의 처리 시간 초과는 아래의 고정 실패 문장 계약을 따른다. 늦은 결과로 후속 AI 단계나 새 TTS를 시작하지 않는다.

확인 목표 p50 2.0초와 질문 목표 p50 4.2초는 실측 지표이며, 4.8초 서버 상한이 목표 달성을 뜻하지 않는다. 앱의 실제 말 끝→판정/재생은 별도로 검증한다.

Workers AI는 whisper-large-v3-turbo(ko/VAD/이전 문맥 끔), MeloTTS(kr/WAV), gpt-oss-20b(low)만 사용한다. LLM은 단일 LlmProvider 구현 뒤에 있고 통일된 내부 toolCalls는 `{id,name:"calendar_today",arguments:{}}`뿐이다. JSON tool 선택은 preload된 실제 Calendar 데이터를 사용하므로 추가 LLM tool loop가 없다. 모델은 비스트리밍 응답을 한 번 읽으며 reasoning은 사용자 텍스트에서 제외한다. 유효한 발화는 STT와 Calendar 조회·decrypt/refresh를 병렬로 시작하고 둘이 완료된 뒤 LLM을 호출한다. 무음은 Calendar도 생략하고, STT 환각 억제 시 미리 시작한 Calendar 결과로 LLM/TTS를 진행하지 않는다. reasoning 포함 max_tokens128과 재생할60토큰 제한은 별개다. LLM 재생 문장은 sanitizer 후UTF-8 60bytes 이하로 제한하고, 결정적 Calendar router 문장은 정확한 시각·제목·장소를 보존하도록 한 문장 90bytes까지 허용한다. 길거나 빈 답변은 고정 한 문장으로 대체한다.

에너지 guard는 검증된 WAV PCM에 대해 RMS -45dBFS, 20ms frame의 활성비율6%를 모두 통과해야 한다. 시청/구독/좋아요/자막/감사합니다/thank you/subscribe가 포함된 STT 문장은 전체 폐기한다. 녹음/전사/일정은 별도 저장하거나 로그에 남기지 않는다. 연결 epoch가 바뀌면 이전 응답을403으로 폐기한다.

정적 노크는 scripts/generate-knock-audio.mjs가 생성한5개 실제MeloTTS WAV다. 일반 build/test/dev는 재생성하지 않으며 `--check`가 sha256/text/model/lang/version을 검증한다. asset 변경 시 version/hash를 갱신한다. AI 요청수 cap(기기20/전체250)과 neuron 예산은 별개다.

### AI 요청 시간 로그

음성 POST(`/v1/briefings`, `/v1/confirm`, `/v1/turns`)는 성공·거절·실패를 포함해 요청당 JSON 로그 한 줄을 출력한다. 고정 경로, 전체 ms, STT ms와 승리 모델·헤지 여부, Calendar ms와 캐시 적중·토큰 갱신 여부, LLM/TTS ms, 실제로 읽은 요청 본문 바이트 수, HTTP 상태만 포함한다. 본문을 읽기 전 거절된 요청의 바이트 수와 사용하지 않은 단계의 시간은 0이다. 제한 시간에 진행 중인 단계는 응답 시점까지의 시간을 기록한다. STT와 Calendar는 병렬이므로 단계 시간의 합이 전체 시간과 일치하지 않는다. 인증·쿼터·연결 epoch 확인 등은 전체 시간에 포함된다. 녹음·전사·일정 내용·기기 식별자·토큰·IP·오류 상세는 로그에 포함하지 않는다. 내부 Calendar 시간 메타데이터는 HTTP 응답에 추가하지 않는다.

### Three-day voice package: bounded answers and explicit failure

The HTTP request/response schemas remain unchanged. Question routing recognizes only the finite whole-utterance forms in `server/src/calendar-router.ts`: COUNT, NEXT_TIME, NEXT_TITLE, NEXT_PLACE and TODAY_SUMMARY. Normalization is NFKC, collapsed whitespace and terminal punctuation; unsupported dates, compound/negative/corrected utterances and write requests use the existing bounded LLM path. No router result authorizes SEND/CHANGE.

COUNT counts distinct event IDs intersecting the Calendar-local day, including past, ongoing and all-day events. With zero events, COUNT and TODAY_SUMMARY return exactly “오늘 일정은 없어요.”. “Next” selects a unique earliest timed start strictly after query time within that same local date, excluding ongoing/all-day events. Ties abstain. No next event produces “이후 시작할 일정은 없어요.”; TODAY_SUMMARY instead includes the distinct count as “오늘 {N}개, 이후 시작할 일정은 없어요.” when the sanitized sentence fits 90 UTF-8 bytes, otherwise it retains the no-next sentence. A missing next-event location produces “다음 일정의 장소는 등록돼 있지 않아요.”. Full canonical router answers must survive sanitization as exactly one sentence within 90 UTF-8 bytes; the router abstains instead of shortening away facts. Summary is a short count plus next-start-time sentence when a next event exists. Decorative square brackets and parentheses in title/place text become spaces, preserving their words before the existing safety checks; title/place fields retain their 200-character limits, and markup, URLs and other unsupported punctuation still cause abstention. Title/place endings and spoken summary times select 이에요 for a final Hangul syllable with a final consonant, otherwise 예요 (for example, 회의실이에요, 강남역이에요 and 사십오 분이에요). A stale local date abstains.

Each device DO may retain one already-generated, compatible single-sentence briefing WAV in memory. The key includes epoch, trip ID, Calendar-local date/timezone, current Calendar content fingerprint, canonical answer and TTS voice/model/version. The full encoded entry is at most 512 KiB; expiry is at most 30 seconds, local midnight or selected next start, whichever is earlier. Disconnect/re-pair/replacement clears it; restart/expiry is a miss. Multi-sentence briefings and count-only audio for other facts are misses. Only an exact matching COUNT rendition is currently published from briefings; incompatible summary/full renditions remain misses. Publication is asynchronous and epoch-checked; every question still requires authentication, quota, guarded STT, current Calendar and a final epoch check. The selected-start/local-midnight boundary and any earlier cache expiry are carried internally to response construction and checked after the final awaited epoch RPC. Expired answers use the pre-generated question failure sentence; no validity field is exposed in JSON. No speculative audio is synthesized.

The outer server deadline remains 4,800 ms from fetch entry. For questions, an internal response-ready cutoff is 3,900 ms. Question STT/Calendar/LLM/TTS waits are bounded by that cutoff, while the underlying DO Calendar fetch retains the outer 4,800 ms deadline so a stall degrades at the question cutoff instead of racing a DO error. Confirm STT uses the outer 4,800 ms deadline and has no degraded success; briefing synthesis retains the 3,900 ms cutoff. LLM starts only with at least 2,300 ms remaining, TTS with at least 1,200 ms, and reservations recheck these requirements before inference. Hedges require the same stage admission time at actual start and do not reserve when it is unavailable. If all attempts fail, the first non-deadline failure is preserved, falling back to the last cause; a skipped hedge cannot turn a quota/provider failure into degradation. Cached router audio requires a 200 ms final-check margin. Up to the remaining 900 ms is reserved for final authorization/epoch validation and response delivery. Late results cannot begin a subsequent stage. The 1,000 ms confirm hedge candidate lost matched accuracy and was reverted to 1,400 ms; Turbo stays primary and the 2,100 ms STT hedge headroom floor remains. The app keeps its safe 500 ms confirm VAD because the 400 ms experiment truncated a real negation fixture; question VAD stays 700 ms.

For a question with an already completed nonempty guarded transcript, a processing deadline or insufficient stage-admission time may return HTTP 200 with a **new** `turnId`, the actual transcript, and exactly one pre-generated failure sentence/WAV: “응답이 늦어 답을 드리지 못했어요.”. This is a degraded response, not a useful Calendar answer. A missing/timed-out STT result remains an error; existing validated silence/hallucination-suppression empty-response semantics remain unchanged. Failed/stalled final authorization, disconnect, non-timeout provider/transport failures and quotas retain existing error behavior. In particular, neuron-reservation denial after successful STT remains HTTP 502 INTERNAL_ERROR and never becomes a time-specific HTTP 200 failure sentence; daily request admission limits remain HTTP 429. An answer whose factual/cache validity expires before response construction also uses the fixed failure sentence after successful final authorization. No failure handling invokes TTS.

Confirm errors remain errors and never invent an intent. The app bundles “말씀을 확인하지 못했어요.” for confirm errors/timeouts and the question failure sentence for question errors/timeouts. A current permitted session plays the matching asset once, honoring navigation/audio focus/cancellation and the original six-second speech-end deadline. A 250 ms presentation margin permits local failure onset before that deadline; late/duplicate responses cannot replace it. After a locally selected failure sentence finishes, the session ends as DEFERRED (“지금은 아님”); a server-returned question failure sentence follows the existing normal reply path and completion event once. The early acknowledgement is unchanged. Degraded/error counts are separate from useful answers and cannot make latency acceptance pass.

Timing logs additionally contain fixed RPC/body/assembly spans and an allowlisted question intent, compatible-cache hit/miss and degradation boolean. These fields contain no transcript, Calendar text, identity, credentials, IP or private error detail. RPC reservation spans overlap inference-stage durations; the spans are not additive wall-clock components. MEASURE_* logs and confirm-decision VOICE_EVENTs are emitted only in DEBUG builds. Measurement entry points and branches require DEBUG/DUMP; failure audio defaults on in both debug and release. The losing confirm-VAD switch and temporary server neuron-envelope experiment have been removed.
