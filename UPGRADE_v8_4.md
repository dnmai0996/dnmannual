# DNM 연차관리 v8.4 (2026-11-07)

- **기존 연차관리 사이트와 GitHub 저장소만** 소스를 업데이트하세요.
- **기존 DNM MES Supabase 프로젝트에 `dnm_leave_*` 별도 테이블 생성**: `database/01_install_leave.sql` → `database/02_mes_sync.sql`.
- **기존 연차관리 Netlify Blobs 전체 상태를 이전**: 관리자 `Excel·백업`에서 최신 JSON 백업 다운로드 → 파일 재선택·검증 → 관리자 확인 → 동결/복제/원본 일치 검증 → `DNM_LEAVE_STORAGE=supabase`로 변경해 재배포.
- **신규/퇴사 직원 MES 작업자 연동**: `dnm_leave_mes_outbox`에 변경을 안전하게 기록, 실제 MES 컬럼 구조를 확인하기 전까지 `enabled=false`. `database/03_check_mes_structure.sql`로 확인한 다음 `database/04_enable_mes_after_review_TEMPLATE.sql` 예시를 수정하여 매핑해야 합니다.
- **퇴사일 도래 시 자동 사용중지 보조**: Netlify scheduled function `leave-daily-sync` 한국시간 09:10.
- **과거 2영업일 사후 연차 신청 허용**: 공휴일·회사휴무일 포함 영업일 계산, 서버/화면 모두 적용.
- **전체 자동테스트**: 기존 41 그룹 + v8.4 9 그룹 통과 (실제 DB/사이트는 별도 검수 필요).

**비밀키는 Netlify 서버 환경변수만 사용.** 기존 MES 서버/계정 함수와 자료는 일괄 변경하지 않습니다. MES에서 작업자 테이블과 별도의 `dnm-accounts` 로그인 연계가 있으므로 작업자 기준정보 연동 성공 여부와 로그인 계정 연결 여부는 각각 검수하세요.

**상세 단계별 매뉴얼: [`docs/설치_이관_사용안내.md`](docs/설치_이관_사용안내.md)**
