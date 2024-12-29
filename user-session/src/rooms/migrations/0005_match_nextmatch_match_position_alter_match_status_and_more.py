# Generated by Django 5.1.2 on 2024-12-19 02:27

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("rooms", "0004_alter_room_status"),
    ]

    operations = [
        migrations.AddField(
            model_name="match",
            name="nextMatch",
            field=models.CharField(editable=False, max_length=64, null=True),
        ),
        migrations.AddField(
            model_name="match",
            name="position",
            field=models.IntegerField(default=0),
        ),
        migrations.AlterField(
            model_name="match",
            name="status",
            field=models.CharField(
                choices=[
                    (0, "created"),
                    (1, "filled"),
                    (2, "in progress"),
                    (3, "finished"),
                ],
                default="created",
                max_length=14,
            ),
        ),
        migrations.AlterField(
            model_name="room",
            name="type",
            field=models.IntegerField(
                choices=[(0, "Match"), (1, "Tournament"), (2, "Single player")],
                default=0,
            ),
        ),
    ]