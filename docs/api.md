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
| `GET /pair/{code}` | 공개 | 없음 | 일반 브라우저는 쿠키 바인딩 후 Google authorization URL로 302, 알려진 인앱 브라우저는 전체 URL 안내 HTML, 404/410 HTML |
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

휴대폰 `/pair/{code}`는 만료·소유 epoch·상태를 확인하고, 일반 브라우저에는 새 state와 Secure·HttpOnly·SameSite=Lax 쿠키로 브라우저 바인딩을 저장한 뒤 Google authorization URL로 302 응답한다. 302와 HTML은 `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, CSP를 사용한다. 알려진 인앱 브라우저에는 Google URL을 열지 않고 연결 안내와 전체 pairing URL을 보여준다. 코드 문구를 별도로 표시하지 않는다. UA 감지는 안내를 위한 보조 수단이다. 실제 로그인은 Google의 secure-browser 정책을 충족하는 외부 브라우저에서 진행해야 한다. HTML 상태 페이지는 요청마다 새 CSP style nonce를 사용하고 스크립트·외부 리소스를 포함하지 않는다.

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
- `DEVICE_DAILY_CAP=100`, `GLOBAL_DAILY_CAP=250`이 `server/wrangler.jsonc`의 기본값이다. 음이 아닌 정수 문자열만 허용하며 0은 해당 AI 요청을 모두 차단한다. 잘못된 설정은 500으로 차단한다. 기기 상한 100은 실시험·녹화·심사처럼 한 기기로 반복 시험하는 경우를 위한 값이며, 비용 보호는 전체 250회와 neuron 예산이 맡는다. 메일 스캔은 기기당 UTC 하루 30회, 행동 승인은 하루 20회로 이와 별도로 제한한다.
- 이는 **유효한 페어링 AI 요청 횟수**의 상한이다. neuron 사용량 계측이 아니며 무료 할당을 보장하지 않는다. 계획의 약 250~400턴/일 추정에서 보수적으로 250회를 선택했다. 브리핑·확인·턴이 같은 상한을 공유한다.
- 실제 AI 호출은 별도 `quota:neurons` UTC 일별 장부에서 보수적인 예상 neuron을 원자적으로 예약한다(10,000/일). 기본 호출과 헤지 모두 시작 전에 예약하며 실패·패배한 호출도 예약을 유지한다. 다른 Worker의 사용량은 포함하지 않으므로 계정 전체 무료 할당을 보장하는 계측값은 아니다. 예약 거부 시 추가 추론을 시작하지 않는다.
- 검사를 통과한 AI 요청은 무음으로 STT를 생략하거나 처리에 실패해도 **1회를 차감**한다. 등록·페어링·OAuth·today·연결 해제·승인/취소 요청은 AI 상한을 차감하지 않는다.
- 기기 상한부터 차감한 뒤 전체 상한을 확인한다. 전체 상한에서 거절되거나 이후 내부 오류가 나면 이미 차감한 기기 슬롯을 돌려주지 않는다. 두 DO를 아우르는 트랜잭션은 사용하지 않으며 보수적인 과소 허용만 발생한다.
- `DeviceAgent`: 기기 인증 해시·paired·기기 일일 카운터, 암호화 Google 연결, 연결 epoch/완료 attempt. 신규 기기는 미페어링이며 공개 임의 상태 변경 API는 없다.
- `Pairing`: `registration:<IP digest>`는 IP별 등록 카운터, `quota:global`은 전체 AI 카운터, `pairing:<code>`는 일회용 코드·state/cookie 해시·tombstone을 보관한다.
- 음성 단계별 헤지는 최대 1회다. STT는 확인 경로에서 1,400ms, 턴 경로에서 1,000ms 뒤 primary와 같은 `@cf/openai/whisper-large-v3-turbo` 요청을 한 번 더 시작한다. 두 요청 모두 동일한 base64 `audio`, `task:transcribe`, `language:ko`, `vad_filter:true`, `condition_on_previous_text:false`를 사용하고, confirm의 `initial_prompt`도 동일하다. 별도의 무프롬프트 `@cf/openai/whisper` 경로는 제거했다. LLM/TTS는 각각 650/600ms 뒤 같은 입력의 두 번째 호출을 시작한다. 남은 시간이 단계 중앙값과 해당 LLM/TTS 진입 시간 한도를 모두 수용할 때만 시작하며, 검증된 첫 결과를 사용한다. 서버 deadline은 `/v1/turns` 6,000ms, `/v1/confirm`·`/v1/briefings`·`/v1/today` 4,800ms이며 아래 action 전용 경로는 8,500ms다. 두 Turbo 결과 모두 기존 환각 억제와 SEND/CHANGE 정확 일치 규칙을 적용하며, 먼저 유효한 결과를 선택한 뒤 패자 controller를 취소하고 늦은 완료/거절을 소비한다. 이미 시작한 AI binding 추론의 예약은 환불하지 않는다. STT hedge도 primary와 같은 Turbo 추정식 `ceil(base64Length * 0.75 / 32000 * 46.63 / 60)`으로 호출 직전에 예약한다. 실제 두 호출이면 두 번 차감하되 HTTP 일일 요청은 한 번이며, 기존 전역 neuron 상한·예약 거절 규칙은 유지한다. timing 로그는 어느 Turbo 요청이 이겨도 `stt.model:@cf/openai/whisper-large-v3-turbo`로 표시하고 hedgeFired는 계속 별도로 기록한다.
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

출력 `audio`는 정확히 `{data:string,mimeType:'audio/wav'}`. `data`는 WAV 전체 바이트의 표준 base64이며 앱이 decode→파일/MediaPlayer로 재생한다. MIME을 upstream header로 추측하지 않고 RIFF 확인 후 설정한다. sample rate는 WAV header가 권위다. 일반 MeloTTS 출력의 실측 44.1kHz와 16kHz 입력은 구분하며, 번들 일정 handoff·일정 추가 불가 안내 두 자산은 기존 MeloTTS 출력을 오프라인 재표본화한 16kHz mono PCM16 WAV를 사용한다. 출력당 decoded WAV 상한 2 MiB(base64 최대 2,796,204자). 빈/잘못된/상한 초과 upstream 음성은 502, 부분 성공이나 가짜 audio 없음. JSON request 512 KiB 제한을 response에 적용하지 않는다.

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

- count=1 online: `오늘 일정이 한 개 있어요. 들으시겠어요?`; offline: `오늘 일정이 한 개 있어요. 정차하면 카드로 보여드릴게요.`
- count≥2 online: `오늘 일정이 여러 개 있어요. 들으시겠어요?`; offline: `오늘 일정이 여러 개 있어요. 정차하면 카드로 보여드릴게요.`
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

`/v1/turns`는 서버 fetch 진입부터 6,000ms absolute deadline을 사용하며 응답 준비 cutoff는 그보다 900ms 이른 5,100ms다. `/v1/confirm`, `/v1/briefings`, `/v1/today`는 기존 4,800ms deadline을 유지한다. 앱의 대화형 질문 턴은 말 끝 기준 `lastVoicedAtMillis + 8000`의 절대 deadline을 사용하고, 기존 250ms presentation margin에 따라 로컬 실패 음성을 사용할 때 정상 응답을 기다리는 타이머는 말 끝 +7,750ms에 끝난다. 로컬 실패 음성을 비활성화한 debug 비교 경로는 기존과 같이 margin 없이 +8,000ms에 deferred로 끝난다. VAD 종료·인코딩·업로드·서버 처리·다운로드·재생 시작이 같은 8초를 나눠 쓰며, 로컬 실패 안내와 늦은 응답 폐기·deferred 규칙을 유지한다. 확인(confirm)은 말 끝 +6,000ms와 같은 250ms margin을 유지한다. 각 STT/Calendar(토큰 refresh 포함)/LLM/TTS에는 새 예산을 주지 않는다. STT 결과가 없거나 최종 인증이 완료되지 않은 timeout은502로 반환한다. 이미 검증된 질문 전사가 있을 때의 처리 시간 초과는 아래의 고정 실패 문장 계약을 따른다. 늦은 결과로 후속 AI 단계나 새 TTS를 시작하지 않는다.

별도의 action 경로(`/v1/capabilities`, `/v1/mail/scan`, `/v1/actions/*`)는 서버 요청 전체에 8,500ms, 앱 ApiActionGateway는 9,500ms의 절대 deadline을 사용한다. STT·DO RPC·TTS가 같은 요청 예산을 나눠 쓴다. 나머지 앱 API의 `ApiClient.deadline()` 기본값은 6,000ms이며, `/v1/turns`의 일정 pending 안내와 고정 거절/명확화 응답도 같은 턴의 6,000ms 전체 예산과 5,100ms response-ready cutoff를 사용한다. 전체 일정 재확인은 별도 readback 요청의 action 예산을 사용한다.

확인 목표 p50 2.0초와 질문 목표 p50 4.2초는 실측 지표이며, 질문 6초·확인 4.8초 서버 상한이 목표 달성을 뜻하지 않는다. 앱의 실제 말 끝→판정/재생은 별도로 검증한다.

Workers AI는 whisper-large-v3-turbo(ko/VAD/이전 문맥 끔), MeloTTS(kr/WAV), gpt-oss-20b(low)만 사용한다. LLM은 단일 LlmProvider 구현 뒤에 있고 통일된 내부 toolCalls는 `{id,name:"calendar_today",arguments:{}}`뿐이다. JSON tool 선택은 preload된 실제 Calendar 데이터를 사용하므로 추가 LLM tool loop가 없다. 모델은 비스트리밍 응답을 한 번 읽으며 reasoning은 사용자 텍스트에서 제외한다. 유효한 발화는 STT와 Calendar 조회·decrypt/refresh를 병렬로 시작하고 둘이 완료된 뒤 LLM을 호출한다. 무음은 Calendar도 생략하고, STT 환각 억제 시 미리 시작한 Calendar 결과로 LLM/TTS를 진행하지 않는다. reasoning 포함 max_tokens128과 재생할60토큰 제한은 별개다. LLM 재생 문장은 sanitizer 후UTF-8 60bytes 이하로 제한하고, 결정적 Calendar router 문장은 정확한 시각·제목·장소를 보존하도록 한 문장 90bytes까지 허용한다. 길거나 빈 답변은 고정 한 문장으로 대체한다.

에너지 guard는 검증된 WAV PCM에 대해 RMS -45dBFS, 20ms frame의 활성비율6%를 모두 통과해야 한다. 시청/구독/좋아요/자막/감사합니다/thank you/subscribe가 포함된 STT 문장은 전체 폐기한다. 녹음/전사/일정은 별도 저장하거나 로그에 남기지 않는다. 연결 epoch가 바뀌면 이전 응답을403으로 폐기한다.

정적 노크는 scripts/generate-knock-audio.mjs가 생성한5개 실제MeloTTS WAV다. 일반 build/test/dev는 재생성하지 않으며 `--check`가 sha256/text/model/lang/version을 검증한다. asset 변경 시 version/hash를 갱신한다. AI 요청수 cap(기기100/전체250)과 neuron 예산은 별개다.

### AI 요청 시간 로그

음성 POST(`/v1/briefings`, `/v1/confirm`, `/v1/turns`)는 성공·거절·실패를 포함해 요청당 JSON 로그 한 줄을 출력한다. 고정 경로, 전체 ms, STT ms와 승리 모델·헤지 여부, Calendar ms와 캐시 적중·토큰 갱신 여부, LLM/TTS ms, 실제로 읽은 요청 본문 바이트 수, HTTP 상태만 포함한다. 본문을 읽기 전 거절된 요청의 바이트 수와 사용하지 않은 단계의 시간은 0이다. 제한 시간에 진행 중인 단계는 응답 시점까지의 시간을 기록한다. STT와 Calendar는 병렬이므로 단계 시간의 합이 전체 시간과 일치하지 않는다. 인증·쿼터·연결 epoch 확인 등은 전체 시간에 포함된다. 녹음·전사·일정 내용·기기 식별자·토큰·IP·오류 상세는 로그에 포함하지 않는다. 내부 Calendar 시간 메타데이터는 HTTP 응답에 추가하지 않는다.

### Three-day voice package: bounded answers and explicit failure

The HTTP request/response schemas remain unchanged. Question routing recognizes only the finite whole-utterance forms in `server/src/calendar-router.ts`: COUNT, NEXT_TIME, NEXT_TITLE, NEXT_PLACE and TODAY_SUMMARY. Normalization is NFKC, collapsed whitespace and terminal punctuation; unsupported dates, compound/negative/corrected utterances and write requests use the existing bounded LLM path. No router result authorizes SEND/CHANGE.

COUNT counts distinct event IDs intersecting the Calendar-local day, including past, ongoing and all-day events. With zero events, COUNT and TODAY_SUMMARY return exactly “오늘 일정은 없어요.”. “Next” selects a unique earliest timed start strictly after query time within that same local date, excluding ongoing/all-day events. Ties abstain. No next event produces “이후 시작할 일정은 없어요.”; TODAY_SUMMARY instead includes the distinct count as “오늘 {N}개, 이후 시작할 일정은 없어요.” when the sanitized sentence fits 90 UTF-8 bytes, otherwise it retains the no-next sentence. A missing next-event location produces “다음 일정의 장소는 등록돼 있지 않아요.”. Full canonical router answers must survive sanitization as exactly one sentence within 90 UTF-8 bytes; the router abstains instead of shortening away facts. Summary is a short count plus next-start-time sentence when a next event exists. Decorative square brackets and parentheses in title/place text become spaces, preserving their words before the existing safety checks; title/place fields retain their 200-character limits, and markup, URLs and other unsupported punctuation still cause abstention. Title/place endings and spoken summary times select 이에요 for a final Hangul syllable with a final consonant, otherwise 예요 (for example, 회의실이에요, 강남역이에요 and 사십오 분이에요). A stale local date abstains.

Each device DO may retain one already-generated, compatible single-sentence briefing WAV in memory. The key includes epoch, trip ID, Calendar-local date/timezone, current Calendar content fingerprint, canonical answer and TTS voice/model/version. The full encoded entry is at most 512 KiB; expiry is at most 30 seconds, local midnight or selected next start, whichever is earlier. Disconnect/re-pair/replacement clears it; restart/expiry is a miss. Multi-sentence briefings and count-only audio for other facts are misses. Only an exact matching COUNT rendition is currently published from briefings; incompatible summary/full renditions remain misses. Publication is asynchronous and epoch-checked; every question still requires authentication, quota, guarded STT, current Calendar and a final epoch check. The selected-start/local-midnight boundary and any earlier cache expiry are carried internally to response construction and checked after the final awaited epoch RPC. Expired answers use the pre-generated question failure sentence; no validity field is exposed in JSON. No speculative audio is synthesized.

The outer server deadline is 6,000 ms from fetch entry for `/v1/turns`, with an internal response-ready cutoff at 5,100 ms (the same relative 900 ms final-check reserve). Question STT/Calendar/LLM/TTS waits are bounded by that cutoff, while the underlying DO Calendar fetch retains the outer 6,000 ms deadline so a stall degrades at the question cutoff instead of racing a DO error. Confirm STT uses the outer 4,800 ms deadline and has no degraded success; briefing synthesis retains the 3,900 ms cutoff. LLM starts only with at least 2,300 ms remaining, TTS with at least 1,200 ms, and reservations recheck these requirements before inference. Hedges require the same stage admission time at actual start and do not reserve when it is unavailable. If all attempts fail, the first non-deadline failure is preserved, falling back to the last cause; a skipped hedge cannot turn a quota/provider failure into degradation. Cached router audio requires a 200 ms final-check margin. Up to the remaining 900 ms is reserved for final authorization/epoch validation and response delivery. Late results cannot begin a subsequent stage. The 1,000 ms confirm hedge candidate lost matched accuracy and was reverted to 1,400 ms; Turbo stays primary and the 2,100 ms STT hedge headroom floor remains. The app keeps its safe 500 ms confirm VAD because the 400 ms experiment truncated a real negation fixture; question VAD stays 700 ms.

For a question with an already completed nonempty guarded transcript, a processing deadline or insufficient stage-admission time may return HTTP 200 with a **new** `turnId`, the actual transcript, and exactly one pre-generated failure sentence/WAV: “응답이 늦어 답을 드리지 못했어요.”. This is a degraded response, not a useful Calendar answer. A missing/timed-out STT result remains an error; existing validated silence/hallucination-suppression empty-response semantics remain unchanged. Failed/stalled final authorization, disconnect, non-timeout provider/transport failures and quotas retain existing error behavior. In particular, neuron-reservation denial after successful STT remains HTTP 502 INTERNAL_ERROR and never becomes a time-specific HTTP 200 failure sentence; daily request admission limits remain HTTP 429. An answer whose factual/cache validity expires before response construction also uses the fixed failure sentence after successful final authorization. No failure handling invokes TTS.

Confirm errors remain errors and never invent an intent. The app bundles “말씀을 확인하지 못했어요.” for confirm errors/timeouts and the question failure sentence for question errors/timeouts. A current permitted session plays the matching asset once, honoring navigation/audio focus/cancellation and the mode-specific speech-end deadline (8,000 ms for conversational questions, 6,000 ms for confirm). A 250 ms presentation margin permits local failure onset before that deadline; late/duplicate responses cannot replace it. After a locally selected failure sentence finishes, the session ends as DEFERRED (“지금은 아님”); a server-returned question failure sentence follows the existing normal reply path and completion event once. The early acknowledgement is unchanged. Degraded/error counts are separate from useful answers and cannot make latency acceptance pass.

Timing logs additionally contain fixed RPC/body/assembly spans and an allowlisted question intent, compatible-cache hit/miss and degradation boolean. These fields contain no transcript, Calendar text, identity, credentials, IP or private error detail. RPC reservation spans overlap inference-stage durations; the spans are not additive wall-clock components. MEASURE_* logs and confirm-decision VOICE_EVENTs are emitted only in DEBUG builds. Measurement entry points and branches require DEBUG/DUMP; failure audio defaults on in both debug and release. The losing confirm-VAD switch and temporary server neuron-envelope experiment have been removed.

## Actions 추가 계약 (2026-11-08)

기존 일정 조회·브리핑·확인 계약은 유지한다. `/v1/turns`는 일정 추가 요청을 저장·검증한 결과가 awaiting_approval이면 선택적인 `actionProposalPending:{actionId,version}`과 짧은 고정 안내 한 문장만 반환한다. 거절/명확화의 고정 안내는 기존 `actionProposal`을 유지하며, 그 외에는 기존 응답 그대로다. 쓰기 승인과 실행은 LLM이 결정하지 않는다. 현재 메일 선정·회의 필드 추출은 보수적인 결정 규칙을 사용하고, 회신 본문은 운전자 받아쓰기에 최소 결정적 정리 A만 적용한다. LLM 초안 작성·정중 어미 변경 B·표현/순서 재작성 C는 허용하지 않는다.

OAuth의 기존 QR 연결에서 Calendar 읽기 두 범위와 `gmail.readonly`, `gmail.compose`, `calendar.events.owned`를 요청하며 `include_granted_scopes=true`를 사용한다. 토큰 검증의 필수 범위는 기존 읽기 두 개만이므로 Calendar-only 연결도 계속 동작한다. 실제 granted scopes로 기능별 권한을 판단한다.

모든 아래 경로는 기기 인증, JSON/no-store/본문 크기 제한을 적용한다. `sentences`와 `holdSentences`의 각 항목은 기존 `{text,audio:{data,mimeType:'audio/wav'}}`다. `expiresAt`은 ISO 문자열, `executeAt`/`serverNow`는 Unix epoch 밀리초다. 승인 응답의 `serverNow`는 해당 HTTP 요청이 Worker에 들어온 가장 이른 접수 시각이며 승인 CAS 시각과 다르다. 승인 응답에 추가된 `holdAudioMs`는 검증된 WAV PCM 길이에서 계산한 안내 길이(밀리초, 올림 정수)다.

행동 안내는 순서가 있는 여러 오디오 항목으로 반환할 수 있다. 회신 재확인은 발신자 부분·받아쓴 본문 부분·고정 승인 안내의 3개, 일정 재확인은 날짜/시간 구간·제목/추가 안내·고정 승인 안내의 3개다. 앱은 배열의 모든 항목을 순서대로 재생하고 마지막 항목이 끝난 뒤 다음 단계를 시작한다. 분할은 발신자·본문·일정 필드로 구성하며, 조각을 합친 문구가 저장 전에 검증한 전체 재확인 문구와 정확히 일치하는지 확인한다. 본문·제목을 담은 조각은 기존 lossless `reply_readback` 정제를 사용하며 내용이나 문장을 생략·절단하지 않는다.

고정 안내는 기존 고정 오디오 캐시를 사용하고, 발신자·본문·제목·날짜/시간처럼 요청마다 달라지는 조각은 캐시하지 않는다. 최초 캐시 miss의 고정 조각과 필요한 모든 가변 조각은 동시에 합성하며, 응답 배열은 완료 순서와 관계없이 발화 순서를 유지한다. 메일 스캔의 고정 도입·질문, 승인 안내, 고정 명확화/거절·보류·종료 문구에도 같은 캐시를 적용한다. 제안·스캔에서 필요한 조각 하나라도 실패하면 부분 배열을 성공으로 반환하지 않는다. 종료 상태 조회의 기존 `sentences:[]` 합성 실패 fallback은 유지한다.

정차 중 기존 설정/연결 화면의 `메일 내용 읽지 않기`는 `운전 중에는 메일이 왔다는 것만 알려드려요.`라는 설명과 함께 이번 이동에만 적용한다. 기본은 꺼짐이며 기존 이동 경계인 주행 후 P 10분에서 해제한다. 잠깐 정차했다가 같은 이동을 이어 가면 유지하고, 이동 종료 후 정차 중 새로 켠 선택은 다음 이동에 적용한다. 운전 중에는 같은 SafetyGate로 숨기고 조작도 차단한다. 켰을 때만 앱은 scan에 `quiet:true`를 추가하며 꺼졌을 때는 기존 `{tripId}` 요청을 그대로 보낸다. 서버는 생략/false를 기존 응답 그대로 처리하고, quiet는 boolean만 허용한다.

`quiet:true`의 비민감 후보는 발신자·제목·요약을 합성하지 않고 `확인이 필요한 메일이 있어요. 정차 후 확인해 주세요.`라는 고정 문장 하나만 `sentences`에 반환한다. 같은 기존 `@cf/myshell-ai/melotts` 한국어 합성과 고정 문구 캐시를 사용하며 cold miss에는 기존 요청 deadline/쿼터 안에서 합성하고 warm hit은 재사용한다. macOS 음성은 사용하지 않는다. `canReply:false`, `canAddCalendar:false`, `replyPromptSentences:[]`이며 `calendarOfferSentences`는 생략하므로 주행 중 회신/일정 제안이나 승인 녹음을 시작하지 않는다. `display`의 기존 발신자·제목·요약은 정차 카드용으로만 보존한다. 후보가 없으면 기존 `candidate:null`, 민감 메일이면 quiet와 무관하게 기존 민감 안내·빈 상세·행동 차단을 유지한다. 앱은 quiet 비민감 응답의 문장/동작 필드도 확인해 고정 안내 한 문장·비활성 행동·빈 후속 문구 계약과 다르면 재생하지 않는다. quiet 안내 뒤 상세는 메모리의 정차 결과 카드에 남기되 새 제안/재확인 흐름에서는 이전 메일 상태를 지운다. 진행 중인 행동이나 안내 음성이 있으면 설정을 바꾸지 못하며 화면과 서비스가 모두 다시 검사한다. 서버는 quiet 설정을 영구 저장하지 않는다.

| 경로 | JSON 요청 | 성공 응답 |
|---|---|---|
| `GET /v1/capabilities` | 없음 | `{calendarRead,mailRead,mailReply,calendarInsert,reconnectRequired}` |
| `POST /v1/mail/scan` | `{tripId,quiet?:boolean}` | `{candidate:null}` 또는 `{candidate:{candidateId,sensitive,canReply,canAddCalendar,sentences,replyPromptSentences,calendarOfferSentences?,display:{sender,subject?,summary?}}}` |
| `POST /v1/actions/proposals` | `{tripId,requestId,kind,candidateId?,audio?}` | `{actionId,version,status,contentHash?,sentences,display,expiresAt,reasonCode?}` |
| `POST /v1/actions/{id}/readback` | `{}` | 저장된 proposal의 `{actionId,version,status,contentHash?,sentences,display,expiresAt,reasonCode?}` |
| `POST /v1/actions/{id}/clarify` | `{version,audio}` | 위와 같은 proposal; Calendar만 한 번 허용 |
| `POST /v1/actions/{id}/approve` | `{contentHash,version?,channel?,audio?}` | `{actionId,status:'holding',executeAt,serverNow,holdAudioMs,holdSentences}` 또는 `{actionId,status:'not_approved',reasonCode,sentences}` |
| `POST /v1/actions/{id}/cancel` | `{}` | `{actionId,status,cancelled}` |
| `GET /v1/actions/{id}` | 없음 | `{actionId,kind,status,executeAt?,outcomeCode?,sentences?}` |

`requestId`는 UUID다. 같은 requestId와 같은 입력은 같은 action을 반환하고, 다른 입력은 409다. 기기당 활성 action 하나, 미승인 제안은 생성 후 90초에 만료한다. `kind`는 `mail_reply` 또는 `calendar_insert`. 회신은 `candidateId`와 받아쓰기 `audio`가 필요하다. 일정은 메일 `candidateId` 또는 직접 요청 `audio` 중 하나만 보낸다. 오디오 인코딩·WAV 에너지 검사는 기존 음성 요청과 같다.

회신 받아쓰기 정리 A는 기존 STT 뒤 새 snapshot을 저장하기 전에만 실행하는 동기식 span 편집이다. 입력은 앞뒤 공백을 제거한 전사뿐이며 메일/연락처/현재 날짜 등 문맥이나 AI 호출을 사용하지 않고 기존 요청 deadline도 연장하지 않는다. 원문부터 기존 본문 정책에 적합해야 한다. 120자 초과·읽을 수 없는 숫자/문자는 정리로 구제하거나 잘라내지 않고 기존 `rejected`로 끝낸다.

허용 범위는 문두 또는 쉼표/종결 부호 뒤의 독립된 `어/음/아/뭐지/뭐냐` 삭제, 검토한 단어 `내일/오늘/모레/자료/회의/확인/일정/정말/감사합니다/부탁드립니다/전달/다시`의 즉시 반복 축약, 같은 슬롯을 한 번 고치는 `X 아니 Y`·`X 아니 아니 Y`·`X 말고 Y`뿐이다. 슬롯은 오늘/내일/모레, 요일, 한글 한~열두 또는 숫자 0~23의 시각+시, 한글/숫자 수량과 동일 단위 개/명/건/번/장이다. 뒤 값의 제한된 조사도 원문 그대로 유지한다. 이름 정정·단위 불일치·복수 정정·대상 불명·아니면/아니라는 보존한다. `저/그`는 대명사/이름 가능성 때문에 삭제 목록에서 제외했고 `네/아니요/그래서/그러니까`, 음악/저녁/그것 같은 실제 단어와 인용문도 보존한다. 호칭 보호는 간단하고 보수적인 토큰 규칙을 쓴다. 공백 정규화 후 `님`·`씨`·`께` 중 하나를 포함하는 토큰이 있으면 마지막 해당 토큰의 끝까지 앞부분 전체를 추임새 삭제, 반복 축약, 공백 축약으로부터 보호한다. `민서씨에게`, `님께서는`처럼 붙은 형태와 오탐을 허용하는 `함께`도 해당한다. 조사/어미·문장부호에 따른 예외, 직함 목록, 단어 수 제한은 두지 않는다. 시각/오늘·내일·모레/요일/숫자+단위 슬롯 문법으로 검증한 자기정정은 어디서나 허용하며, 직접 제출된 span도 같은 문법 검증을 통과해야 한다. 마지막 호칭 토큰 뒤의 편집은 기존 규칙을 따른다. span 검증기는 생성기와 동일하게 이 경계를 적용한다. 예를 들어 `어 오늘 자료를 정리해서 민수님께 보내겠습니다`는 `어 오늘 자료를 정리해서 민수님께 보내겠습니다.`로 유지된다. 보호된 원문에는 기존 선택적 마지막 마침표만 더할 수 있다. 일반 공백 정규화는 보호 영역 밖에서만 적용하며, 종결 부호가 없고 의문/인용이 모호하지 않은 검토된 서술/요청 어미에만 마지막 `.` 하나를 붙일 수 있다. 어미·철자·숫자 표기·날짜 해석·인사·서명은 바꾸거나 추가하지 않는다.

서버는 최대 6개 삭제 span의 범위·순서·겹침·허용 문법을 재검증하고 유지 문자를 원문에서 순서대로 조립한다. 기존 `isSafeReplyBody`, Unicode code point 기준 `0.70(N-C) ≤ M ≤ N+2` 및 120자 상한, `못/안/않/없/가능하면/면/것 같/수 있`의 원래 출현 횟수 보존을 모두 검사한다. 검증된 자기정정/검토된 즉시 반복 외의 이름·숫자·날짜·단위는 철자와 위치를 그대로 유지한다. 여기서 C는 실제 적용된 문법 검증 자기정정 삭제 span의 code-point 길이뿐이다. filler·반복·공백 삭제분은 하한 기준에서 제외하지 않는다. 하나라도 실패하면 일부 편집도 채택하지 않고 적합한 원문 전체로 복귀한다. 선택한 최종 본문 하나로 화면·전체 낭독·암호화 payload·hash·Gmail 초안/전송을 결합하며 requestId replay와 readback은 저장된 최종 본문을 재정리하지 않는다. 정리 진단은 `reason:applied|raw_kept|raw_invalid`, code-point `rawLength/finalLength`만 기록하고 본문·이름·식별자·편집 이력은 남기지 않는다. 전체 낭독 후 새 승인·취소 창과 작성/내용 확인 offer 문구는 유지한다. 일반 `/v1` 정제 및 행동 STT 후처리도 그대로다.

음성 일정 요청은 두 번의 HTTP 요청으로 처리한다. `/v1/turns`는 기존 파싱·전체 readback 검증·turnId/requestId 중복 방어를 거쳐 제안을 저장하고, 가변 재확인 TTS 없이 번들 고정 오디오 `일정 내용을 확인할게요.` 한 문장과 `actionProposalPending:{actionId,version}`을 반환한다. 이 한 문장은 다른 클립과 같은 `@cf/myshell-ai/melotts`의 `kr` 음성으로 미리 생성한 음성을 오프라인에서 16kHz mono PCM16 WAV로 재표본화한 자산이며 모듈에 보존하므로 콜드 시작에도 TTS/추론 호출 없이 반환한다. 명시적으로 허가된 생성은 `node server/scripts/generate-action-handoff-audio.mjs --generate`로 기존 Wrangler 로그인과 AI binding을 사용하며, 요청 기록으로 중복 실행·헤지·자동 재시도를 막는다. `--check`는 추론 없이 임베디드 MeloTTS 출처·본문·WAV·SHA-256 및 존재하는 빌드 manifest를 검사하고, 출처가 없거나 다르면 실패한다. macOS 음성 생성기는 제거했다. 가변 readback의 기존 MeloTTS도 유지한다. 일반 턴의 필드는 그대로이며 이 경로도 `/v1/turns`의 6,000ms deadline과 5,100ms 응답 준비 cutoff를 쓴다. 고정 거절/명확화 문장은 기존 응답을 유지한다.

앱은 짧은 문장을 끝까지 재생한 뒤 원래 trip/generation과 ID/version을 ActionSession에 넘긴다. `POST /v1/actions/{id}/readback`에 빈 JSON 객체를 보내고, 저장된 제안을 기존 3개/4개 조각으로 합성해 받는다. 서버 전체 8,500ms·앱 gateway 9,500ms를 적용한다. readback은 기기 인증·페어링·연결 epoch·일반 AI 요청/추론 쿼터를 적용하지만 action 생성/승인 제한을 소모하거나 action/version/contentHash/만료를 새로 만들지 않는다. 일반 만료 정리는 수행할 수 있다. ID 없음은 404, 만료/폐기된 payload는 410, holding·preparing·sending·cancelled·succeeded·failed·unknown 상태는 409다. rejected 제안의 고정 안내는 만료 전까지 조회할 수 있다. 반복 조회도 같은 저장 내용을 읽으며 가변 오디오는 재합성할 수 있다.

앱은 readback의 ID/version이 pending 값과 일치할 때만 기존 READBACK → 승인 → HOLD 흐름으로 진입한다. readback 실패는 승인 전 안전 종료이며 approve를 호출하지 않는다. 알려진 제안 ID만 best-effort cancel 한 번으로 정리하고 정리 응답이 새 흐름의 상태를 바꾸지 않게 한다. trip/generation 변경 뒤의 응답도 버린다. 기존 full `actionProposal`과 메일 기반 일정 흐름은 계속 지원한다. Demo gateway와 e2e fake도 같은 경계를 제공한다. 이 변경은 `executeAt = casNow + holdAudioMs + 14_500`, 최초 접수 `serverNow`, 승인 STT, 후보 보존, 실제 Gmail 제목/Message-ID 검증·보존과 단 한 번 발송 규칙을 변경하지 않는다.

고정 handoff와 일정 추가 불가 자산은 각각 `action-handoff-v2`, `calendar-unavailable-v2`다. `node server/scripts/generate-action-handoff-audio.mjs --resample-existing` 및 `--resample-existing --calendar-unavailable`은 보존된 실제 MeloTTS 응답과 원본 manifest 해시를 대조한 뒤 ffmpeg libswresample(`filter_size=64`, `cutoff=0.95`)로 44,100Hz → 16,000Hz mono PCM16 변환만 수행한다. 새 추론은 호출하지 않으며 원본 응답·manifest는 보존하고 파생 WAV·manifest는 각 빌드 디렉터리의 `resampled/`에 쓴다. 임베디드 출처에는 원본 WAV의 SHA-256·표본율·재표본화 설정과 출력 SHA-256을 기록한다. `--check`는 임베디드 자산만으로도 검증하고, 로컬 빌드 기록이 있으면 함께 대조한다. 일정 pending handoff의 전체 JSON 응답은 130,000 UTF-8 바이트 미만으로 검사한다.

메일 후보 snapshot은 무작위 `candidateId`를 키로 DO SQLite에 암호화해 90초 보존한다. 발신자·주소·제목·본문·원본 메시지 ID는 암호문 안에만 저장하며, 암호문은 해당 DO·연결 epoch·후보 ID·만료 시각에 결합한다. DO가 메모리에서 제거돼도 새 인스턴스가 같은 후보를 복구해 회신이나 메일 기반 일정을 제안할 수 있다. 없거나 만료된 후보는 410이며, 만료 정리와 계정 해제/교체 때 저장된 후보를 삭제한다. 만료는 알람 및 다음 요청의 정리 과정에서 처리한다. trip별 60초 offered 캐시는 메모리에 유지하며 소실 시 새 스캔을 수행할 수 있지만, 새 후보가 이미 발급된 다른 candidateId의 원본을 바꾸지는 않는다.

메일 스캔은 목록 조회 후 최대 10개 메일 상세를 같은 취소 신호로 동시에 읽고, 최신순 선택과 기존 필터를 적용한다. 이미 성공 처리한 메시지는 아래의 7일 처리 기록으로 제외하고 같은 최대 10건 안에서 다음 최신 유효 후보를 고른다. 모두 제외되면 `candidate:null`이며 추가 페이지를 조회하지 않는다. 상세 조회 하나라도 실패하면 스캔도 실패하고, 스캔 종료 시 진행 중인 나머지 조회를 취소한다. 선택된 일반 후보의 최신 메시지·thread 재검증은 유지한다. 필요한 메일 안내·답장 입력 안내·일정 제안 음성도 동시에 합성하며 고정 문구의 오디오 캐시는 그대로 사용한다. action 전용 전체 8,500ms deadline과 기존 연결 epoch 검사를 적용한다. 승인 처리 예산의 확장은 serverNow의 최초 접수 시각, CAS 기준 executeAt, 보류·취소 및 중복 실행 방어 규칙을 바꾸지 않는다.

메일 회신 `succeeded` 또는 메일 후보에서 만든 일정 추가 `succeeded`가 확정되면 해당 기기에서 원본 Gmail 메시지를 **성공 시점부터 7일간 처리 완료**로 기록한다. 결과 불명 회신은 SENT 읽기 대조로 최종 성공이 확인된 뒤에만 기록하며, failed/cancelled/expired/rejected/not-approved/unknown은 기록하지 않는다. 직접 음성 일정은 대상 메일이 없다. 성공 상태 전이와 기록 삽입은 동일 SQLite transaction으로 반영한다. 신규 스캔의 재제안을 막는 정책이며, 이미 발급된 후보로 명시적으로 요청하는 기존 회신 후 일정 추가 흐름을 차단하지 않는다.

DO의 `handled_mail`에는 `message_hash`, 연결 `epoch`, `handled_at`, `expires_at`만 저장한다. HKDF-SHA-256으로 기존 암호화 비밀과 기기 context에서 별도 용도의 HMAC 키를 도출하고, 연결 epoch와 Gmail 메시지 ID에 HMAC-SHA-256을 적용한다. 평문 메시지/thread ID·주소·제목·본문은 이 테이블·로그·응답에 추가하지 않는다. 메일 일정의 원본 ID는 명확화 후에도 기존 암호화 snapshot 안에서만 유지한다. 처리 기록은 action의 24시간 정리와 독립적으로 7일 만료하며 알람/다음 요청에서 정리한다. 계정 교체·연결 해제 때 전부 삭제하고, 이전 epoch의 늦은 완료가 다시 기록하지 못하도록 검사한다. 성공하면 offered 캐시를 비우고 캐시 hit에서도 처리 여부를 확인한다. 원본 ID가 없는 과거 버전의 일정 성공을 제목/본문으로 추정하거나 Google 재조회로 소급 등록하지 않는다.

행동 경로(`/v1/capabilities`, `/v1/mail/scan`, `/v1/actions/*`)는 성공·인증 거절·실패를 포함해 요청당 JSON 시간 로그 한 줄을 남긴다. 필드는 고정 `route`(행동 ID는 `:id`), `totalMs`, `googleListMs`, `googleMessageGetsMs`, `googleValidationMs`, `sttMs`, `ttsMs`, `messageCount`, HTTP `status`다. `googleMessageGetsMs`는 목록 후보 상세 조회의 병렬 구간이며, `googleValidationMs`는 선택된 메시지와 thread의 재조회 구간이다. `sttMs`는 해당 요청의 STT 처리 시간이며 `ttsMs`는 동시 합성의 겹치는 시간을 중복 합산하지 않는다. 사용하지 않은 단계와 캐시로 생략한 Google 조회는 0이며, `messageCount`는 이번 요청에서 상세 조회 대상으로 고른 ID 수(최대 10)다. 외부 deadline이 진행 중인 스캔 RPC보다 먼저 끝나 메타데이터를 받지 못하면 Google 시간·건수는 `null`이고 실패 단계는 `google_scan`이다. 실패 시에만 고정된 오류 클래스명과 단계로 구성한 `error:{name,stage}`를 추가하며 메시지·stack·원인 객체는 남기지 않는다. 토큰·메일 주소·제목·본문·음성·행동 ID와 provider 오류 내용은 기록하지 않고, 시간 메타데이터는 HTTP 응답에 추가하지 않는다.

Proposal의 `status`는 `awaiting_approval`, `needs_clarification`, `rejected`다. 회신 본문과 일정 제목은 동일한 승인 텍스트 규칙으로 검사한다. 회신 본문은 120자 이내의 한글·영문자·숫자·일반 공백과 `. , ? ! ' "`만 허용하며 자르지 않는다. `+ : % /` 등 나머지 기호, 숫자에 붙은 구분 기호, 7자리 이상 숫자 묶음에 더해 두 자리 이상이면서 0으로 시작하는 숫자 묶음과 라틴 문자에 붙은 숫자도 승인 전에 거절한다. `1,2,3번`·`3.5`·`10:30`·`010 1234`·`A01회의`·`프로젝트 007 회의`·`v2`는 거절한다. 회신은 “한 문장으로 짧게 다시 말씀해 주세요.”, 일정은 제목을 정확히 읽을 수 없다는 안내와 `rejected`를 반환한다. `2026년`·`3명`·`10시`처럼 허용된 텍스트는 숫자 묶음만 각각 `이천이십육년`·`삼명`·`십시`로 바꾸고 나머지 문자·따옴표·문장부호·단어 경계를 보존한다. 두 행동의 승인 낭독은 모두 `reply_readback` 합성 경로를 사용한다. 기존 `/v1` 일반 음성 정제는 그대로다. 낭독 발신자명은 괄호 안 내용을 제외하고 한글·라틴 문자·숫자·단일 공백으로 만들며, 비면 “보낸 분”을 사용한다. 실제 회신 수신 주소는 바꾸지 않는다. 전체 낭독문도 같은 합성 정책에 맞는지 저장 전에 검증하며 실패는 활성 행동을 남기지 않는 rejected로 끝낸다.

Calendar는 본인 primary에 개인 일정만 생성한다. 날짜와 시작·종료 시각을 각각 파싱하고, 지원하는 시각 문법은 `[오전|오후|아침|저녁|밤]? N시 (M분|반)?`와 `HH:MM`이다. 끝 시각의 분·반을 시작에 적용하지 않는다. 종료 표현이 없을 때만 기본 30분을 적용하며, 명시한 종료나 다른 시각 표현을 해석하지 못하면 한 번 질문하거나 거절한다. 파싱되지 않은 시각 단어를 제목으로 넘기지 않는다. 명확한 종료는 시작의 오전/오후를 상속할 수 있으며 ISO 날짜의 하이픈은 시간 구간 구분자로 쓰지 않는다. 음성 명령의 add/register 동사 바로 앞에 붙은 명령 명사 `일정`·`일정을`만 제목 끝에서 제거하고, `일정 조율 회의` 같은 제목 내부 단어와 메일에서 선택한 subject는 유지한다.

승인 낭독은 달력 시간대의 현재 연도와 다른 해에만 연도를 포함하고, 날짜는 `11월 10일` 형태로 만든다. 시각은 `오후 세 시`·`세 시 반`·`오전 열 시 십오 분`처럼 시는 고유어, 분은 한자어로 직접 쓰며 0분은 생략한다. 같은 날짜와 오전/오후는 종료 쪽에서 반복하지 않으며 날짜나 오전/오후가 달라지면 종료 쪽에도 표시한다. 서울 달력의 예는 `11월 10일 오후 세 시부터 세 시 반까지 '팀 회의' 일정을 내 캘린더에 추가할게요.` 뒤 고정 승인 문장이다. 종료 시각을 이미 읽으면 기본 30분 기간 안내를 중복하지 않는다. 시간대는 primary calendar의 IANA zone이며 `Asia/Seoul`은 별도 낭독하지 않는다. 다른 시간대는 식별자를 명시하고 `/`, `_`, `+`, `-`를 각각 슬래시·밑줄·플러스·마이너스로 읽어 전용 정제 경로에서 조용히 삭제하지 않는다. 전체 낭독문과 분리된 문장들을 제안 저장 전에 검증하고, 저장한 문장을 그대로 사용해 연도 경계를 지나 재조회해도 카드·낭독이 달라지지 않게 한다. 분리된 문장이 없는 이전 제안은 같은 display snapshot에서 재구성한 이전 표준 낭독 형식과 정확히 일치할 때만 호환 재생한다. 다른 이전 낭독·회신·새 저장 문장의 불일치는 합성 전에 502로 거절한다. 숫자 날짜만 기존 lossless `reply_readback` 경로에서 발음으로 바꾸며 일반 `/v1` sanitizer는 바꾸지 않는다.

메일 후보에서 만드는 일정 제목은 본문 잔여 문구가 아니라 후보의 메일 제목을 사용한다. 제목 앞뒤 공백과 선두의 `Re:`·`Fwd:`·`FW:` 접두사를 대소문자 구분 없이 반복 제거한다. 결과가 비거나 기존 `isSafeReplyBody` 승인 텍스트 규칙·`reply_readback` 낭독 검증을 통과하지 못하면 고정 제목 `메일 일정`을 사용한다. 예를 들어 `회의 일정 안내`는 그대로, `Re: Fwd: 주간 회의`는 `주간 회의`, `A01 회의`는 `메일 일정`이다. 날짜·시작·종료 시각은 기존 방식대로 본문에서만 파싱하며, 추가 질문이 필요하면 선택한 메일 제목을 암호화된 제안에 보존한다. 화면·승인 낭독·실제 삽입 이벤트는 같은 제목을 사용한다. 음성 명령으로 만드는 일정의 제목 추출·검증은 기존과 같다.

앱은 전체 낭독 완료 후에만 approve를 호출한다. `channel='voice'`는 새 승인 녹음이 필요하며 서버의 guarded STT와 exact 사전만 판단한다. 회신은 `보내|보내줘|보내 줘`, 일정은 `추가해|추가해줘|추가해 줘|등록해|등록해줘|등록해 줘`. `응/네`, 부정형, 인용·추측, 무음·잡음은 승인하지 않는다. `parked_button`은 앱의 안전 게이트와 실제 사용자 탭을 신뢰한다. 기존 `{contentHash}`만으로는 실행을 승인하지 않는다.

행동 음성 승인은 전용 STT 모드로 primary Whisper에 종류별 `initial_prompt`를 제공한다. 회신에는 보내/보내줘와 취소·아니·하지 마·보내지 마, 일정에는 추가해/추가해줘·등록해/등록해줘와 취소·아니·하지 마·추가하지 마·등록하지 마를 함께 명시한다(허용된 띄어쓰기 변형 포함). 이 힌트는 짧은 발화를 목록의 단어 쪽으로 편향시킨다. 재확인 낭독 뒤 제한된 응답을 받는 경로에만 적용하며, 서버는 기존 WAV 에너지·VAD gate와 동사 전체 정확 일치를 계속 적용하고 승인 뒤에는 10초 취소 청취 창을 둔다. 예를 들어 전사 `보내.`는 회신을 승인하지만 `호네`, 거절·취소 표현은 not_approved다. 행동 전사 `dictation`, `approval_mail`, `approval_calendar`는 8,500ms action 예산 안에서 한국어 primary만 한 번 호출하며 hedge를 시작하지 않는다. 느린 primary·실패·timeout에도 무프롬프트 대체 STT를 호출하지 않는다. 일반 `/v1/turns`의 1,000ms 및 `/v1/confirm`의 1,400ms hedge 시작 시각과 primary 입력·프롬프트·후처리는 유지하며, hedge 역시 같은 Turbo 모델과 동일한 파라미터를 사용한다. 행동 primary의 기존 프롬프트·후처리도 유지한다. 이미 holding인 같은 승인 요청의 재시도는 STT를 다시 실행하지 않고 저장된 실행 시각을 돌려준다. 힌트 적용이 실제 음성 인식의 정확도를 보장한다는 뜻은 아니다.

음성 승인 응답이 `not_approved`이면 같은 요청에서 해당 미승인 action을 `cancelled`, `outcomeCode:'not_approved'`로 끝내고 암호화 payload와 draft 참조를 비운다. 이 정리는 고정 거절 음성 합성보다 먼저 수행해 음성 합성이 실패해도 슬롯이 남지 않게 한다. 현재 epoch와 제공된 version/contentHash를 확인하며 오래된 snapshot은 409다. 이미 holding·preparing·sending·unknown 또는 종료된 action은 건드리지 않는다. 공개 승인 응답은 기존 `status:'not_approved',reasonCode:'explicit_approval_required'` 형식 그대로다.

새 회신·메일 기반 일정·음성 일정 제안은 검증과 암호화가 끝난 뒤 기존 awaiting_approval/needs_clarification을 `cancelled`, `outcomeCode:'superseded'`로 정리하고 새 행을 넣는다. 두 변경은 하나의 SQLite 트랜잭션이므로 INSERT 충돌·실패가 이전 제안만 취소하는 부분 상태를 남기지 않는다. 기존 requestId 재시도는 같은 action을 읽고 자기 자신을 supersede하지 않는다. holding·preparing·sending·unknown이 있는 경우 새 제안은 거절하며 해당 action은 바꾸지 않는다. 이 unknown 차단은 같은 기기의 이전 연결 epoch 행에도 적용한다. 연결 교체로 payload가 비워져 복구할 수 없는 unknown도 기존 24시간 정리 전까지 슬롯을 막으며, 임의로 취소/성공으로 바꾸지 않는다. 승인·제안 제한, 90초 제안 만료와 24시간 terminal 보존 규칙은 유지한다.

음성 일정 턴의 proposeCalendar가 ActionError로 거절되면 502로 바꾸지 않고 `지금은 일정을 추가할 수 없어요.` 고정 문장 한 개로 HTTP 200을 반환한다. actionProposal/actionProposalPending은 포함하지 않는다. 이 문장은 기존 생성기의 `--calendar-unavailable` 변형으로 생성한 실제 MeloTTS `kr` 출력을 오프라인에서 16kHz mono PCM16로 재표본화한 자산이다. 콜드 시작에도 런타임 TTS는 없으며 같은 변형의 `--check`로 출처·문구·WAV·SHA-256을 확인한다. 다른 오류·인증/epoch 검사는 기존 실패 규칙을 유지한다.

승인 안내는 두 종류 모두 **“취소하려면 '취소'라고 말씀하세요.”** 한 문장이다. 이 고정 음성은 `server/src/action-hold-audio.ts`의 사전 생성 MeloTTS `kr` 자산이며 16kHz mono PCM16이다. 새 음성/버튼 승인과 holding 재시도 모두 자산을 직접 반환하므로 콜드 시작이나 고정 캐시 축출에도 요청 시점 hold TTS는 없다. 실제 WAV data chunk·sample rate·channels로 계산한 안내 길이(현재 3,603ms)를 CAS에 전달한다. `node server/scripts/generate-action-handoff-audio.mjs --hold --generate`는 명시적으로 허가된 재생성 한 번만 수행하고 요청 ledger·원본 응답을 보존하며 자동 재시도/헤지는 없다. `--hold --check`는 추론 없이 모델/언어/버전·고정 문구·원본/16kHz WAV SHA-256과 PCM 메타데이터를 확인한다. 기존 음성을 오프라인 ffmpeg로 재표본화하며 macOS 음성은 사용하지 않는다. **`executeAt = casNow + holdAudioMs + 14_500`**이며 `casNow`는 DO가 승인 상태를 바꾸는 시각이다. 응답의 `serverNow`는 Worker fetch 진입에서 별도로 기록한 해당 요청의 접수 시각으로, deadline에서 역산하지 않는다. 새 승인의 `executeAt - serverNow`에는 승인 STT와 그 밖의 CAS 이전 처리 시간도 포함된다. 앱은 기존의 보수적 계산 `holdUntil = sentAt + (executeAt - serverNow)`를 유지해 서버 처리 시간을 잃지 않는다. 14,500ms margin은 응답 다운로드·WAV 디코드/준비·재생 오버헤드를 위한 여유이며, 실제 남은 시간이 짧으면 기존 10초 청취 진입 검사와 안전 취소를 유지한다. 같은 version/hash의 holding 재시도는 저장된 executeAt과 holdAudioMs를 유지하고, serverNow만 그 재시도 HTTP 요청의 접수 시각을 반환한다. 음성 길이·전달 지연 때문에 실제 남은 청취 시간을 확보할 수 없을 때의 안전 취소는 앱에서도 확인한다. 앱의 마감에 서버가 아직 holding이면 상태만 다시 조회하며 재승인하지 않는다. cancel은 `awaiting_approval/needs_clarification/holding/preparing`에서만 성공하며 `sending` 뒤에는 성공을 반환하지 않는다. 앱의 발화 시작 시 cancel을 먼저 전달하고, 서버에 도착하지 않은 취소를 성공으로 단정하지 않는다.

Gmail은 원본 From 한 명에게만 같은 thread의 초안으로 회신한다. 자동 메일·다른 Reply-To·헤더 주입·민감/명령 주입 메일은 제외한다. 실제 발송 직전에 `sending`과 `sendAttempted=1`을 저장하며 action당 `drafts.send`는 최대 한 번이다. 초안 생성/발송 응답 유실이나 crash는 `unknown`으로 남기고 새 초안이나 send를 자동 재시도하지 않는다. SENT의 검증 시 보존한 Message-ID·thread·수신자·제목·본문을 대조하는 읽기 복구만 허용한다. draft 부재나 검색 결과 없음은 성공/미발송의 증거가 아니다. 발송 API 수락을 수신자 전달 보장으로 해석하지 않는다.

`sending` CAS 전에는 알려진 draftId를 GET해 승인 snapshot의 thread, 단일 To, Subject, In-Reply-To, References와 본문을 대조하고, Message-ID는 안전한 단일 값인지 검증한다. 초안은 승인 본문과 같은 **단일 루트 text/plain**이어야 한다. multipart·추가 plain/HTML 파트·첨부·알 수 없는 본문 구조와 추가 Cc/Bcc는 거절한다. 읽기 실패나 불일치면 발송하지 않고 알려진 초안만 삭제 한 번을 시도한 뒤 `status:'failed',outcomeCode:'draft_mismatch'`로 끝낸다. 이 경우 `sendAttempted`는 0이다. 동일 requestId의 동시 INSERT가 UNIQUE 충돌하면 해당 행을 다시 읽어 같은 fingerprint는 같은 action으로 돌려주고 다른 입력만 409로 거절한다.

비ASCII 회신 제목은 [RFC 2047](https://www.rfc-editor.org/rfc/rfc2047)의 `=?UTF-8?B?…?=` encoded-word로 생성한다. UTF-8 코드 포인트를 나누지 않고 word마다 최대 39바이트를 넣어 encoded-word 75자 이하와 `Subject: `를 포함한 물리적 줄 76자 이하를 지킨다. word 사이는 CRLF + 공백으로 접으며, ASCII 제목은 그대로 유지한다. 검증은 Gmail이 반환한 디코딩된 Subject와 승인한 `replySubject(candidate)`의 정확 일치를 계속 요구한다.

Gmail이 Message-ID를 바꿀 수 있으므로 생성 요청에는 기존 상관 Message-ID를 유지하되 이를 발송 허가나 복구 검색의 기준으로 사용하지 않는다. 저장된 초안에 Message-ID가 정확히 하나 있어야 하며 `safeHeader`의 998자 상한·제어문자 거절과 `<local@domain>` 형식을 검사한다. 허용 범위는 ASCII dot-atom local과 영숫자/하이픈 domain label이다. 공백·주석·따옴표 local·헤더 추가·중복/누락은 거절한다. 모든 초안 검증이 성공하면 실제 Message-ID를 기존 `draft_id` 암호문 안에 draftId와 함께 action별 AAD로 저장한다. 이 저장과 epoch·취소·deadline 재검사가 끝나야 `preparing → sending`, `sendAttempted=1` CAS와 단 한 번의 send가 가능하다. 승인 payload와 contentHash는 바꾸지 않으며 이 값은 공개 응답이나 로그에 포함하지 않는다.

`unknown` 회신은 암호문에서 복원한 실제 Message-ID를 같은 안전성 검사로 다시 검증한 뒤 `in:sent rfc822msgid:<각괄호를 뺀 실제 Message-ID>`로만 검색한다. 조회 결과의 Message-ID·thread·단일 수신자·제목·본문이 모두 같아야 성공으로 복구한다. 저장된 ID가 없거나 안전하지 않은 이전 행은 상관 ID로 대체 검색하지 않는다. 검색 결과 없음·조회 실패는 `unknown`을 유지하며 재발송하지 않는다. 기존 불일치 시 발송 차단·알려진 초안 한 번 삭제·민감 내용 없는 진단 로그 규칙도 유지한다.

초안 검증마다 JSON 진단 로그를 한 줄 남긴다. `reasonCodes`는 `draft_id`, `thread`, `to`, `cc_bcc`, `subject`, `in_reply_to`, `references`, `message_id`, `structure`, `body` 중 실패한 항목이며 성공하면 빈 배열이다. 조회 전 중단은 `precondition`, 조회 실패는 `read_error`, 비교 예외는 `comparison_error`다. `structureReason`은 첫 구조 실패인 `extra_payload_key`, `mime_type`, `filename`, `parts`, `part_id`, `header_unparsed`, `content_disposition`, `content_type`, `body_keys`, `body_data`, `body_size` 중 하나이며 구조 실패가 없으면 null이다. `parts`는 빈 배열이어도 거절한다.

진단의 나머지 값은 루트 payload의 `headerNames`와 `mimeType`, `messageId.exactlyOne`·`domainEndsWithMailGmailCom` 불리언, `body.expectedLength`·`actualLength`(JavaScript 문자열 길이), `equalsAfterCrlfAndTrailingWhitespace`·`endsWithNewline` 불리언뿐이다. 헤더 이름과 MIME 타입은 고정된 알려진 이름만 표시하고 그 외 문자열은 `other`로 가린다. MIME 타입이 없으면 null이다. 본문 구조를 검증하지 못했거나 조회하지 못하면 실제 길이는 null, 본문 불리언은 false다. 정규화 동등성은 CRLF를 LF로 바꾸고 끝 공백을 제거한 뒤의 비교이며, 마지막 개행 여부는 원래 본문의 마지막 문자가 LF인지 표시한다. 이 관찰값은 승인 판단을 완화하지 않는다. 주소·제목·본문·헤더 값·식별자·토큰·provider 오류 내용은 기록하지 않으며, 로그 실패도 검증 결과에 영향을 주지 않는다.

민감 분류는 한국어·영어의 의료/정신건강, 법률, 인사/급여, 금융/인증 정보를 보수적으로 검사한다. **법률 분류의 문서화된 범위는 소송·변호사·법원·고소·합의·법률(법률 상담 포함)·법무와 영어 `lawyer`, `legal advice`, `lawsuit`, `court`다.** 암은 독립 단어 또는 진단/치료/검사/수술 문맥에서, HR은 인사평가·인사발령·인사위원회·성과평가·근무평가·징계·해고·연봉·급여처럼 지정한 업무 문맥에서 분류한다. “암스테르담 팀”, “성능평가 회의”, “인사드립니다”를 이 부분 문자열만으로 민감 처리하지 않는다. 민감 후보는 “민감한 내용으로 보여 정차 후 확인해 주세요.”만 발화하며 발신자·제목·요약을 비우고 회신/일정 기능을 끈다. 지시 주입 의심 메일은 후보에서 생략한다. 키워드 분류는 알려진 한계이며 목록 밖 표현을 포함한 모든 민감 문맥을 판별한다는 보장은 하지 않는다.

행동 받아쓰기에는 별도 STT 후처리를 사용한다. 에너지 검사는 유지하고, 문장 전체가 구두점·공백 정리 후 알려진 환각 문구와 같을 때만 전사를 생략한다. 긴 정상 문장 속 “감사합니다/좋아요”는 보존한다. 기존 `/v1/turns` 후처리와 최종 승인 exact 사전은 변경하지 않는다.

사용자 확정에 따라 “no external write”는 `sending` 전 취소가 이긴 경우 **발송 0건 보장**을 뜻한다. 초안은 hold 종료 후에만 만들며, 생성 요청 진행 중 취소가 이기면 send 없이 `cancelled`를 유지하고 해당 요청에서 반환된 draftId만 DELETE 한 번으로 정리한다. 생성 응답 대기/유실·삭제 실패/응답 유실은 `outcomeCode:'cancelled_draft_cleanup_unconfirmed'`로 표시해 정차 화면에서 “Gmail에 초안이 남아 있을 수 있어요.”를 안내할 수 있게 한다. 알려진 초안 삭제가 확인되면 `user_cancelled`로 갱신한다. ID를 모르면 다른 초안을 추측해 지우지 않으며, 취소된 action에 생성/발송/삭제 재시도 루프를 돌리지 않는다.

Calendar는 action에 결합한 `mobi`+SHA-256 hex eventId를 저장한다. 재시도는 같은 ID와 같은 body를 쓰고, timeout/5xx/409에서 해당 ID를 GET해 필드와 private fingerprint를 확인한다. 다른 내용이면 덮어쓰거나 다른 ID를 만들지 않는다. 참석자·초대·알림 발송·기존 일정 수정은 없다.

승인 payload·draft 참조는 기존 AES-GCM 패턴과 action별 AAD로 암호화한다. terminal 상태 후 24시간에 행/암호문을 정리하며, 연결 해제/교체 시 개인 payload와 후보 snapshot을 즉시 폐기하고 미실행 action을 취소한다. 메일 본문·주소·전사·음성·토큰·provider 오류 내용은 로그에 남기지 않는다. 후보 개인 내용의 SQLite 보존은 위의 90초 암호화 snapshot 규칙을 따르며, 평문 메모리 캐시는 짧게 유지한다. 민감 메일은 고정 안내만 재생하고 subject/summary는 반환하지 않는다.

새 경로의 소유자 밖 ID는 404, version/hash/활성 action 충돌은 409, 만료는 410, 권한 부족은 403, provider/합성 실패는 502다. scan/proposal/clarify 및 실제 음성 인식은 기존 요청·neuron 예산을 적용하며, cancel/status는 요청 한도 소진 때문에 차단하지 않는다. terminal 상태 조회에서 음성 합성/예산이 실패해도 상태와 `sentences:[]`를 반환하므로 앱은 상태를 보존해야 한다.


### 행동 단계별 안내

제안 수락은 작성/내용 확인만 시작한다. 메일 offer는 `회신 내용을 작성할까요?`, 일정 offer는 `일정 내용을 확인할까요?`다. `응/네`는 이 단계에서만 수락이며 propose/dictation으로 이동한다. 전체 재확인을 모두 들은 뒤 새로 받는 `보내`/`추가해` 승인과 기존 버튼 게이트만 실행을 예약한다. 두 고정 최종 승인 문장과 취소 청취 창은 유지한다.

| 확인된 단계 | 회신 | 일정 |
| --- | --- | --- |
| 실행 전 종료: proposal/readback 실패, not_approved, expired, rejected, 승인 전·실행 전 취소 | 보내지 않았어요. | 일정을 추가하지 않았어요. |
| 확인된 실행 실패: failed, draft_mismatch, Calendar의 확정 오류 | 보내지 못했어요. | 일정을 추가하지 못했어요. |
| 결과 불명: unknown, 발송 응답 유실, 승인 전달 뒤 불확실성 | 처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 보내지 않을게요. | 처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 추가하지 않을게요. |

복구한 actionId의 종류를 아직 모르면 `처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 처리하지 않을게요.`를 사용하고 상태 조회로 종류를 확인한다. unknown에서 approve나 send를 다시 시도하거나 재시도를 권하지 않는다. 승인을 발행하기 전의 전송/명확화/재확인 실패는 결과 불명으로 표시하지 않는다. `보내지 않았어요`는 전송 0건을 뜻하며 Gmail 초안의 삭제 성공을 보장하지 않는다. `cancelled_draft_cleanup_unconfirmed` 등 기존 outcomeCode는 보존한다.

변경된 서버 고정 문구는 새 실제 MeloTTS kr 음성으로 채운 캐시에서 반환한다. 앱은 같은 문구의 새 번들 WAV를 사용하며 응답에 sentences가 없거나 음성 자원을 읽지 못해도 화면 결과 문구는 단계에 맞게 유지한다. 서버 고정 캐시는 원본을 오프라인 재표본화한 16kHz mono PCM16, 앱은 원본 44.1kHz mono PCM16를 사용한다. 생성기 `server/scripts/generate-action-wording-audio.mjs`와 `--check`는 문구·모델·언어·버전·원본/출력 SHA-256·WAV 형식을 대조한다. 전체 안내 목록과 변경 전후 대응은 [행동 안내 문구 목록](action-wording.md)에 기록한다.
