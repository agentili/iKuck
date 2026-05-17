-- Initial Schema for iRicetto

-- 1. users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. pantries
CREATE TABLE IF NOT EXISTS pantries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. pantry_items
CREATE TABLE IF NOT EXISTS pantry_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pantry_id UUID NOT NULL REFERENCES pantries(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50),
    quantity NUMERIC NOT NULL DEFAULT 0,
    unit VARCHAR(20),
    expiry_date TIMESTAMP WITH TIME ZONE,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pantry_id, name)
);

-- 4. recipes
CREATE TABLE IF NOT EXISTS recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    difficulty VARCHAR(20) CHECK (difficulty IN ('easy', 'medium')),
    preparation_time INTEGER,
    servings INTEGER,
    ingredients JSONB NOT NULL DEFAULT '[]',
    instructions JSONB NOT NULL DEFAULT '[]',
    tags JSONB DEFAULT '[]',
    image_url VARCHAR(500),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. recipe_history
CREATE TABLE IF NOT EXISTS recipe_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipe_id UUID REFERENCES recipes(id),
    meal_type VARCHAR(20) CHECK (meal_type IN ('breakfast', 'lunch', 'dinner')),
    completed_date TIMESTAMP WITH TIME ZONE NOT NULL,
    rating INTEGER CHECK (rating BETWEEN 1 AND 5),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_pantry_items_pantry_id ON pantry_items(pantry_id);
CREATE INDEX IF NOT EXISTS idx_pantry_items_name ON pantry_items(name);
CREATE INDEX IF NOT EXISTS idx_recipe_history_user_id ON recipe_history(user_id);
CREATE INDEX IF NOT EXISTS idx_recipe_history_completed_date ON recipe_history(completed_date);
CREATE INDEX IF NOT EXISTS idx_recipes_difficulty ON recipes(difficulty);

-- GIN indices for JSONB
CREATE INDEX IF NOT EXISTS idx_recipes_tags_gin ON recipes USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_recipes_ingredients_gin ON recipes USING GIN (ingredients);
