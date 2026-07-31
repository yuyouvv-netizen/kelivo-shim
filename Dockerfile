FROM node:22-bookworm-slim

WORKDIR /src

COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN chmod +x /src/entrypoint.sh

EXPOSE 8787

CMD ["bash", "/src/entrypoint.sh"]
