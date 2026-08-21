FROM node:22-bookworm-slim

WORKDIR /src

COPY package.json ./
RUN npm install --omit=dev

COPY . .
# Keep the large resident-process core untouched. The tiny runtime wrapper adds
# the authenticated one-time Claude-chat import routes, then loads the core.
RUN chmod +x /src/entrypoint.sh \
    && cp /src/server.js /src/server-core.js \
    && cp /src/server-runtime.js /src/server.js

EXPOSE 8787

CMD ["bash", "/src/entrypoint.sh"]
