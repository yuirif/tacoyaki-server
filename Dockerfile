# 타코야키 박스 릴레이 서버 — Railway/Docker 배포용.
# 서버는 빌드 단계 없이 tsx 로 src/index.ts 를 직접 실행한다(작은 릴레이라 충분).
# 데이터(계정·세션방·업로드 자산)는 /app/data 에 영속 → Railway 볼륨을 이 경로에 마운트할 것.
FROM node:20-slim
WORKDIR /app

# 의존성 먼저(레이어 캐시 활용). tsx 는 devDependency 라 --omit=dev 로 빼면 실행이 안 되므로 전체 설치.
COPY package.json ./
RUN npm install --no-audit --no-fund

# 서버 소스 복사(.dockerignore 가 node_modules·data 제외).
COPY . .

ENV NODE_ENV=production
# PORT 는 Railway 서비스 변수로 8787 고정(index.ts 가 process.env.PORT 사용) · 공개 도메인도 8787 로 연결.
EXPOSE 8787

# ⚠️ 영속 데이터(/app/data)는 Docker VOLUME 이 아니라 Railway Volume 으로 마운트한다(railway volume, mount path /app/data).
#    Railway 빌더는 Dockerfile 의 VOLUME 지시문을 거부하므로 여기엔 두지 않는다. 스토어 기본값 <cwd>/data = /app/data 와 일치.

CMD ["npm", "start"]
