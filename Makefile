.PHONY: build clean stop start restart test

build:
	go build -o landuse-srv ./cmd/srv

clean:
	rm -f srv

test:
	go test ./...
