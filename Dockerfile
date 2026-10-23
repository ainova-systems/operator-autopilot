# The runtime as a container for hosts that run it outside a user service. It carries no agent
# CLIs: mount or install claude/codex/herdr as the host requires.
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm pack --pack-destination /out

FROM node:24-bookworm-slim
RUN --mount=type=bind,from=build,source=/out,target=/out npm install --global /out/*.tgz && npm cache clean --force
USER node
WORKDIR /project
ENTRYPOINT ["operator"]
CMD ["run"]
