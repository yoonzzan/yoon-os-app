# Task 5 — App graph-primary read

## 변경

- `graph-current.json`을 검증·캐시·로드하는 `validateGraphCurrent`, `loadGraphCurrent`를 추가했다.
- `composeGraphFacts`가 유효한 record node의 태그와 typed link를 facts로 구성한다.
- `composeRecords`는 record ID와 `content_hash`가 정확히 일치하는 graph node만 facts의 정본으로 쓴다. graph가 없거나 호환되지 않거나 해당 node가 없거나 hash가 다르면 기존 enrichment facts로만 fallback한다.
- graph의 known-empty node는 빈 facts를 보존하며 legacy tags/links를 재병합하지 않는다. enrichment current는 status, privacy, receipt 등 처리 상태 필드만 조합한다.
- graph cache/unavailable/incompatible 상태를 화면 경고로 구분했다.

## Fixture 기반 검증

`LIFE_OS_ROOT=/Users/yoon/Desktop/yoonzzan-life-os/.worktrees/tag-connection-graph-migration node tests/enrichment-view.mjs`

- production `tests/projector_app_fixture.py`가 생성한 graph/status pair를 직접 소비했다.
- source-only, auto-only, mixed, user remove, typed link, known-empty, unsupported schema, record/content-hash mismatch, source-hash-only change, content-hash change를 검증했다.

## 결과

- `git diff --check`: pass
- `node --test tests/*.mjs`: pass (`fail 0`)
- fixture command: pass

## 리뷰 보완

- `prepData()`의 실제 runtime compose 호출이 `GRAPH`를 전달하도록 고쳤고, source records + enrichment current + graph current를 거치는 known-empty 통합 회귀 테스트를 추가했다.
- tombstone record node도 알려진 graph node로 간주해 빈 facts가 legacy tags/links를 막는다.
- validator의 `source_locator`(1024), link `raw_text`(4096), multiline newline/tab 및 production 허용 separator, control-character 경계를 canonical Python contract에 맞춰 테스트했다.
- `tests/projector-sidecar.fixture.json`을 production `projector_app_fixture.py` 출력으로 갱신했다. 기본 Node 테스트는 graph fixture가 없으면 실패하며, `LIFE_OS_ROOT` 사용 시 checked-in fixture와 production 출력의 동일성도 확인한다.
- graph cache·ETag·timestamp key를 owner/repository/branch namespace로 분리하고 config switch가 이전 graph cache를 읽지 않는 회귀 테스트를 추가했다.

## 최종 품질 보완

- `privacy_decision`은 production의 exact one-of scope인 `{source_hash}` 또는 `{content_hash}`만 허용하고, 해당 sidecar record의 같은 hash와 일치할 때만 수용한다. source/content/stale/malformed 및 UI current-scope 회귀를 추가했다.
- graph tag는 Python `casefold` 결과를 raw display에서 JavaScript `toLowerCase()`로 재생성해 비교하지 않는다. projector가 낸 canonical key의 안전성, metadata 정확한 shape, raw display control/length, tag-node key membership만 검증한다. `Straße` → `strasse`와 malformed/mismatched metadata 회귀를 추가했다.
