# relay-service 이미지.
#
# 서버와 관리 UI를 함께 빌드해 넣는다. 받자마자 브라우저로 쓸 수 있다.
#
#   docker build -t relay-service .
#   docker run -p 4100:4100 -v ./data:/app/data relay-service
#   → http://localhost:4100/web
#
# 안경앱은 별도 저장소라 이미지에 없다. 쓰려면 /app/glasses 에 볼륨으로 붙인다.

# --- 관리 UI 빌드 ---
#
# 서버와 따로 둔다. UI만 고쳤을 때 서버 층을 다시 만들지 않게 하려는 것이다.
FROM node:22-alpine AS web

WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

# --- 서버 빌드 ---
FROM node:22-alpine AS build

WORKDIR /app

# 의존성을 먼저 받는다. 소스만 바뀌면 이 층은 캐시에서 나온다.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# 런타임 의존성만 남긴다. TypeScript가 빠져 크게 줄어든다.
RUN npm ci --omit=dev

# --- 실행 ---
FROM node:22-alpine AS runtime

# 알림·체크리스트 시각이 한국 기준으로 찍히게 한다.
# 다른 지역이면 TZ 환경변수로 덮어쓰면 된다.
RUN apk add --no-cache tzdata
ENV TZ=Asia/Seoul

WORKDIR /app

# root로 돌리지 않는다. node 이미지에 이미 있는 계정을 쓴다.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=web   --chown=node:node /web/dist ./web
COPY --chown=node:node package.json ./

# 계정·알림·체크리스트가 여기 쌓인다. 볼륨으로 붙이지 않으면
# 컨테이너를 지울 때 함께 사라진다.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4100 \
    RELAY_DATA_DIR=/app/data \
    RELAY_WEB_ROOT=/app/web \
    RELAY_GLASSES_ROOT=/app/glasses

EXPOSE 4100

# 죽은 컨테이너를 오케스트레이터가 알아채게 한다.
# /auth/status는 인증 없이 열려 있어 헬스체크에 쓸 수 있다.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
