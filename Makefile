STORAGE_GAME=storage/game-data
STORAGE_USER=storage/user-data

VOLUMES :=		/goinfre/game-db-data \
				/goinfre/user-db-data

all: create-dirs run-compose

att: run-compose

run-compose:
	docker compose up --build

create-dirs:
	mkdir -p $(STORAGE_GAME)
	mkdir -p $(STORAGE_USER)

venv:
	cd src
	python3 -m venv core
	source core/bin/activate
	pip install django

submodule:
	git submodule init
	git submodule update

clean:
	docker compose down
	docker volume prune -a -f
	sudo rm -rf $(STORAGE_GAME) $(STORAGE_USER)

w:
	docker stop game-sync-session-worker
	docker stop game-worker
	docker start game-sync-session-worker
	docker start game-worker

mkdir:
	sudo mkdir -p $(VOLUMES)

fclean:
	docker compose down
	docker volume prune -a -f
	sudo rm -rf $(VOLUMES)

build: mkdir
	docker compose up --build

re: fclean build