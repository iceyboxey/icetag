# Render: set this service to "Docker". Chromium needs memory: use an instance with 2 GB or more.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "server.js"]
