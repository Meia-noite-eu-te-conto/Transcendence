all:
	docker compose up --build

clean:
	docker compose down -v
	docker volume prune -a -f

fclean: clean
	sudo rm -rf $(VOLUMES)

re: fclean build