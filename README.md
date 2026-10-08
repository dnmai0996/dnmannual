# (주)디엔엠 연차관리 시스템 v8.0.0-dnm

(주)디엔엠 근로자명부를 초기 데이터로 반영한 Netlify Functions 기반 연차관리 웹시스템입니다.  
더사가 연차관리 프로그램의 구조를 기반으로 하되, 디엔엠 직원관리·결재라인·관리자 계정 요구사항을 반영했습니다.

## 주요 반영사항

- `public/index.html`에서 시작하는 Netlify 서비스 구조
- 디엔엠 근로자명부 기준 직원 47명 초기 등록
- 관리자 별도 계정: `admin / 0996`
- 대표이사 김정배 계정은 관리자와 동일한 권한 부여
- 일반 직원 최초 비밀번호: `1111`
- 직원관리 기능 보강: 연락처, 비고, 관리자 권한, 연차 결재자 지정
- 결재자 선택 방식 적용
  - 신청자가 결재라인을 선택
  - 선택한 결재라인의 마지막 결재자가 최종 결정권자
  - 대표이사를 자동 최종승인자로 고정하지 않음
- Netlify Blobs 기반 운영데이터 저장
- GitHub Actions 문법/기능 점검 포함

## 초기 로그인

| 구분 | 로그인 ID | 비밀번호 | 비고 |
|---|---|---|---|
| 관리자 | `admin` | `0996` | 전체 사용자·기준정보·백업 관리 |
| 대표이사 | `김정배` | `1111` | 관리자와 동일 권한, 최초 로그인 후 변경 권장 |
| 일반 직원 | 직원명 | `1111` | 동명이인/괄호 표기는 `admin_docs/dnm_employees_seed.json` 확인 |

## 폴더 구조

```text
public/
  index.html        # 서비스 시작 파일
  app.js            # 프론트엔드 SPA
  style.css         # 화면 스타일
netlify/functions/
  api.mjs           # Netlify Function API
  _lib/initial-state.js  # 디엔엠 초기 데이터
admin_docs/
  dnm_employees_seed.json # 초기 직원 데이터 확인용
netlify.toml        # Netlify 배포 설정
package.json        # Node 22 및 점검 스크립트
```

## GitHub + Netlify 권장 배포

이 시스템은 정적 HTML만 있는 프로그램이 아니라 Netlify Functions와 Netlify Blobs를 사용합니다. 따라서 단순 폴더 업로드보다 GitHub 저장소와 Netlify 자동배포 연결을 권장합니다.

1. GitHub에서 비공개 저장소를 생성합니다. 예: `dnm-annual-leave-management`
2. 이 폴더 안의 파일 전체를 저장소 루트에 업로드하거나 GitHub Desktop으로 커밋합니다.
3. Netlify에서 해당 GitHub 저장소를 Import합니다.
4. Netlify 설정은 `netlify.toml`이 자동 적용됩니다.
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
   - Node version: `22`
5. 배포 후 Netlify 주소에 접속하여 `admin / 0996`으로 로그인합니다.
6. 기존 Netlify 사이트에 덮어 배포하여 과거 데이터가 남아 있으면, 관리자 메뉴 → Excel·백업 → `디엔엠 초기자료 재설정`을 실행합니다.

## 기존 Netlify 사이트에 배포할 때 주의

Netlify Blobs 운영데이터는 코드 재배포만으로 자동 삭제되지 않습니다. 기존 더사가 또는 다른 테스트 데이터가 남아 있으면 화면에 이전 자료가 보일 수 있습니다.

- 새 사이트로 운영: 가장 안전합니다.
- 기존 사이트 재사용: 로그인 후 `디엔엠 초기자료 재설정`을 실행하세요.
- 초기화 전에는 반드시 JSON 백업을 다운로드하세요.

## 로컬 점검

Node.js 22 이상이 설치된 환경에서 다음 명령으로 점검할 수 있습니다.

```bash
npm install
npm run check
npm test
```

정상 결과 예시:

```text
DNM smoke test OK: employees=47, admin=admin, CEO=김정배
```

## 개인정보 및 보안 주의

근로자명부 기반 데이터에는 직원명, 부서, 직책, 입사일, 연락처 등이 포함됩니다. GitHub 저장소는 반드시 비공개로 생성하고, 운영 전 관리자와 직원은 초기 비밀번호를 변경하는 것을 권장합니다.
