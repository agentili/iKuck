import { ChatView } from '../components/chat/ChatView';
import { useNavigate } from 'react-router-dom';

export default function ChatPage() {
  const navigate = useNavigate();

  const handleStartCooking = (recipe: any) => {
    navigate(`/cooking/${recipe.id}`);
  };

  const handleOpenPantry = () => {
    navigate('/pantry');
  };

  return (
    <ChatView
      onStartCooking={handleStartCooking}
      onOpenPantry={handleOpenPantry}
    />
  );
}