FROM alpine:latest

RUN apk add --no-cache nodejs npm python3 make g++

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 5173

CMD ["npx", "vite", "--host"]
