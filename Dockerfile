# The runtime as a container for hosts that run it outside a user service. It carries no agent
# CLIs: mount or install claude/codex/herdr as the host requires.
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.build.json README.md LICENSE ./
RUN npm ci
COPY src ./src
# `npm pack` builds dist/ through the prepack script.
RUN mkdir /out && npm pack --pack-destination /out

FROM node:24-bookworm-slim
COPY --from=build /out/ /tmp/operator/
RUN npm install --global /tmp/operator/*.tgz && rm -rf /tmp/operator && npm cache clean --force
USER node
WORKDIR /project
ENTRYPOINT ["operator"]
CMD ["run"]
