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
