FROM node:22-slim

WORKDIR /plugin

# Bundle the solc toolchain into the image so compile runs without network
# access. npm honors HTTP(S)_PROXY, so this also works inside Ignite's
# egress-filtered isolated git build.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.cjs /plugin/index.js

# The container is kept idle; Ignite execs `node /plugin/index.js <op>`.
CMD ["sleep", "infinity"]
