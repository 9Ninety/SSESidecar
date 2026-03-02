FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY src ./src

ENV PORT=8080
EXPOSE 8080

CMD ["bun", "run", "start"]
