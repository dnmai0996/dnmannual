# DNM 연차관리 v8.4 배포 안내

**기존 운영 중인 연차 Netlify 사이트 및 GitHub 저장소를 그대로 사용합니다.** MES 저장소는 수정하지 마십시오.

1. 기존 연차 사이트 **JSON 백업** 및 프로그램 ZIP/GitHub 커밋 보관.
2. 기존 MES Supabase 프로젝트 SQL Editor에서 `database/01_install_leave.sql`과 `02_mes_sync.sql` 실행.
3. **기존 연차 Netlify 사이트**에 `DNM_LEAVE_SUPABASE_URL`, `DNM_LEAVE_SUPABASE_SECRET_KEY` 서버 환경변수 등록. `DNM_LEAVE_STORAGE`는 아직 `blobs`.
4. GitHub Desktop으로 전체 v8.4 파일 병합 → Commit/Push → Netlify 재배포. `public`/`netlify/functions`, Node 22.
5. 연차관리 관리자 `Excel·백업` → JSON 다운로드 → 파일 재선택 → 데이터 이관·해시검증 완료. 이 단계에서 기존 Blobs 읽기 전용 동결.
6. **마지막에** Netlify에 `DNM_LEAVE_STORAGE=supabase` 추가/변경하여 재배포. 로그인·이력·결재·백업을 검사.
7. MES 자동연계는 작업자 테이블 구조 확인 후 **별도 활성화**해야 함. `03_check_mes_structure.sql` → `04_enable_mes_after_review_TEMPLATE.sql`.

상세 초보자 매뉴얼: [`docs/설치_이관_사용안내.md`](docs/설치_이관_사용안내.md).

⚠️ 동일 Netlify 사이트의 프로그램 교체와 실제 DB 이관은 **다른 단계**입니다. 데이터 이관 성공 전 저장소 설정을 `supabase`로 바꾸면 이전 자료가 로딩되지 않습니다.
