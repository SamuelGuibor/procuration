FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libreoffice-core libreoffice-writer \
      fonts-dejavu fonts-liberation && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# HOME/profile graváveis e explícitos para o LibreOffice (evita falha ao criar perfil)
ENV HOME=/tmp

COPY package.json ./
RUN npm install --production
COPY index.js ./

EXPOSE 3001
CMD ["node", "index.js"]
