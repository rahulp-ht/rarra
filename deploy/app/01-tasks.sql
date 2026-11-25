CREATE TABLE IF NOT EXISTS tasks (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title varchar(120) NOT NULL CHECK (length(trim(title)) > 0),
    done boolean NOT NULL DEFAULT false
);
