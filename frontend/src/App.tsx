import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Navigate to="/suggest" />} />
        <Route path="/login" element={<div>Login Page</div>} />
        <Route path="/register" element={<div>Register Page</div>} />
        <Route path="/suggest" element={<div>Suggestions Page</div>} />
        <Route path="/pantry" element={<div>Pantry Page</div>} />
        <Route path="/history" element={<div>History Page</div>} />
      </Routes>
    </Router>
  );
}

export default App;
