-- Abilita estensione per UUID
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Tabella Utenti (Profilo esteso)
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  avatar_url TEXT
);

-- Tabella Dispensa
CREATE TABLE public.pantry_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  ingredient_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  quantity DECIMAL(10,2) DEFAULT 1.0,
  unit TEXT DEFAULT 'pz',
  added_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabella Ricette
CREATE TABLE public.recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  difficulty SMALLINT NOT NULL CHECK (difficulty BETWEEN 1 AND 2),
  prep_time_min SMALLINT NOT NULL CHECK (prep_time_min <= 45),
  description TEXT,
  instructions TEXT[] DEFAULT '{}',
  image_url TEXT,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabella Ingredienti Ricetta (Relazione Many-to-Many)
CREATE TABLE public.recipe_ingredients (
  recipe_id UUID REFERENCES public.recipes(id) ON DELETE CASCADE,
  ingredient_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  quantity DECIMAL(10,2),
  unit TEXT,
  PRIMARY KEY (recipe_id, normalized_name)
);

-- Storico Esecuzioni (per algoritmo 2 nuovi + 1 vecchio)
CREATE TABLE public.user_recipe_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  recipe_id UUID REFERENCES public.recipes(id) ON DELETE CASCADE NOT NULL,
  executed_at TIMESTAMPTZ DEFAULT NOW(),
  meal_type TEXT NOT NULL CHECK (meal_type IN ('pranzo', 'cena'))
);

-- Row Level Security (RLS)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pantry_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_recipe_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;

-- Policy di base
CREATE POLICY "Users can manage their own profile" 
ON public.profiles FOR ALL 
USING (auth.uid() = id);

CREATE POLICY "Users can manage their own pantry items" 
ON public.pantry_items FOR ALL 
USING (auth.uid() = user_id);

CREATE POLICY "Anyone can view recipes" 
ON public.recipes FOR SELECT 
TO authenticated USING (true);

CREATE POLICY "Users can view and add to their history" 
ON public.user_recipe_history FOR ALL 
USING (auth.uid() = user_id);
