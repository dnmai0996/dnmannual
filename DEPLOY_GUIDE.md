# 배포 안내

v8.2 교체 절차는 **UPGRADE_v8_2.md**를 따르세요.

기존 Netlify 프로젝트와 GitHub 저장소를 유지합니다.
프로젝트 루트의 netlify.toml을 사용합니다.

- Publish directory: `public`
- Functions directory: `netlify/functions`
- Node.js: 22
- 기존 Netlify Blobs 운영 자료 유지
- 서버 의존성 설치를 포함하는 GitHub 연동 배포 권장
- 프로젝트 루트를 정적 공개 디렉터리로 지정하지 마세요.

Source: https://docs.netlify.com/build/data-and-storage/netlify-blobs/
Netlify의 getStore는 사이트 범위 저장소이며 새 배포 후에도 자료를 유지합니다. 새 사이트는 별도 저장소입니다.
