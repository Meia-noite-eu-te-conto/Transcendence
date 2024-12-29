STORAGE_GAME=storage/game-data
STORAGE_USER=storage/user-data

VOLUMES :=		/goinfre/game-db-data \
				/goinfre/user-db-data

all: mkdir build

clean:
	docker compose down -v
	docker volume prune -a -f

fclean: clean
	sudo rm -rf $(VOLUMES)

build:
	docker compose up --build

re: fclean build