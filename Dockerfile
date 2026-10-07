# 타코야키 박스 릴레이 서버 — Railway/Docker 배포용.
# 서버는 빌드 단계 없이 tsx 로 src/index.ts 를 직접 실행한다(작은 릴레이라 충분).
# 데이터(계정·세션방·업로드 자산)는 /app/data 에 영속 → Railway 볼륨을 이 경로에 마운트할 것.
FROM node:20-slim
WORKDIR /app

# 의존성 먼저(레이어 캐시 활용). 함께 배포되는 lock 그대로 설치(npm ci) — 재배포마다 같은 판이 돌게 한다.
# tsx·typescript 는 devDependencies 지만 런타임(tsx 직접 실행)에 필요하므로 --omit=dev 를 붙이면 안 된다.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 서버 소스 복사(.dockerignore 가 node_modules·data 제외).
COPY . .

ENV NODE_ENV=production
# PORT 는 Railway 서비스 변수로 8787 고정(index.ts 가 process.env.PORT 사용) · 공개 도메인도 8787 로 연결.
EXPOSE 8787

# ⚠️ 영속 데이터(/app/data)는 Docker VOLUME 이 아니라 Railway Volume 으로 마운트한다(railway volume, mount path /app/data).
#    Railway 빌더는 Dockerfile 의 VOLUME 지시문을 거부하므로 여기엔 두지 않는다. 스토어 기본값 <cwd>/data = /app/data 와 일치.

# 힙 천장이 컨테이너 한도보다 높으면 V8 이 정리를 미루다 호스팅에 통째로 끝나고, 그 순간 접속해 있던
# 사람이 전부 함께 튕긴다(메모리로 죽는 것은 예외가 아니라서 어떤 그물로도 못 받는다).
# 서버가 켤 때 두 수치를 로그에 적으므로, 천장이 한도보다 높게 잡혀 있으면 호스팅의 환경변수에
#   NODE_OPTIONS=--max-old-space-size=<한도의 3/4 MB>
# 를 넣어 맞춰 준다. 기동 명령에서 계산하지 않는 이유는, 그 계산이 어긋나면 서버가 아예 안 켜지기 때문이다.
CMD ["npm", "start"]
