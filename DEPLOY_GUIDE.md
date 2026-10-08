# (주)디엔엠 연차관리 GitHub·Netlify 배포 가이드

## 1. 권장 운영 방식

```text
GitHub 비공개 저장소
  ↓ push/commit
Netlify 자동 배포
  ↓
public/index.html 서비스
  ↓
netlify/functions/api.mjs API
  ↓
Netlify Blobs 운영데이터 저장
```

## 2. GitHub 저장소 생성

1. GitHub에서 새 저장소를 생성합니다.
2. 저장소 이름 예시: `dnm-annual-leave-management`
3. 공개 범위는 반드시 `Private`를 권장합니다.
4. 이 프로젝트 폴더의 파일 전체를 저장소 루트에 업로드합니다.
5. GitHub Desktop 사용 시 이 폴더를 로컬 저장소로 지정하고 Commit → Push 합니다.

## 3. Netlify 연결

1. Netlify 로그인
2. Add new project 또는 Import an existing project 선택
3. GitHub 저장소 선택
4. 배포 설정은 `netlify.toml`에서 자동 인식됩니다.
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
   - Node version: `22`
5. Deploy 실행

## 4. 첫 접속 확인

1. Netlify 주소 접속
2. 관리자 로그인: `admin / 0996`
3. 관리자 메뉴 → 사용자 관리에서 직원 47명 확인
4. 대표이사 김정배 계정이 관리자 권한인지 확인
5. 결재자로 지정할 직원은 사용자 수정에서 `연차 승인자` 체크
6. 직원은 연차 신청 시 결재자를 선택하고, 마지막 결재자가 최종 결정권자가 됨

## 5. 기존 Netlify 사이트에 덮어 배포한 경우

기존 운영 데이터가 남아 있으면 다음을 실행합니다.

1. 관리자 로그인
2. 관리자 메뉴 → Excel·백업
3. 필요 시 JSON 백업 다운로드
4. `디엔엠 초기자료 재설정` 클릭
5. 자동 로그아웃 후 다시 `admin / 0996` 로그인

## 6. 운영 전 필수 변경 권장

- 관리자 비밀번호 변경
- 대표이사 비밀번호 변경
- 결재자 명단 확인
- 직원 연락처 및 비고 확인
- 휴직·퇴사자 여부 확인
- 회사 연차 산정 기준 확인
