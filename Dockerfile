FROM node:22-bookworm-slim

WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN chmod +x /src/entrypoint.sh

EXPOSE 8787

CMD ["bash", "/src/entrypoint.sh"]
