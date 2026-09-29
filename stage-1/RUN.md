# Running Pocketful Stage 1

Zero runtime dependencies, plain Node.js `http`. Run these from inside this
directory (`stage-1/`).

## Build

    docker build -t pocketful-stage1 .

## Run

    docker run -e PORT=8080 -p 8080:8080 pocketful-stage1

The service listens on `0.0.0.0:$PORT` (default `8080`) and needs no outbound
network access at run time. Check it with:

    curl http://localhost:8080/health
